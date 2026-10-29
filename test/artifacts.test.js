import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { artifactStats, candidatePaths, fingerprint, verifyArtifacts } from '../lib/artifacts.js'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { Store } from '../lib/store.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-art-')), 'mem.db'))
  migrate(db)
  return { db, store: new Store(db) }
}

function readState(store, id) {
  // 状态存 meta 表（`artifact:<unitId>`），**不写 units.meta**：那一列是同步载荷
  const raw = store.getMeta(`artifact:${id}`, null)
  return raw ? JSON.parse(raw) : null
}

test('候选路径：只挑像文件的（带扩展名/目录），过滤 URL 与协议噪声', () => {
  const got = candidatePaths('改动落在 `lib/schema.js`，参考 https://example.com/a.js 与 ssh://git@x/y。')
  assert.ok(got.includes('lib/schema.js') || got.some((p) => p.includes('schema.js')), `实际：${JSON.stringify(got)}`)
  assert.ok(!got.some((p) => p.startsWith('http')), '不得把 URL 当文件')
})

test('指纹核对：首次建立基线，文件改了记 changed，文件没了记 missing（都不动 importance/status）', () => {
  const { db, store } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'memcore-art-files-'))
  const file = join(dir, 'schema.js')
  writeFileSync(file, 'version 1')
  const unit = store.insertUnit({
    track: 'memory',
    scope: 'global',
    kind: 'fact',
    content: `数据库迁移在 \`${file}\` 里，别乱改。`,
  })
  const importance0 = Number(store.getUnit(unit.id).importance)

  // 第一轮：建立基线（长路径要能被扫描到——extractEntities 有 80 字符上限）
  const first = verifyArtifacts(store, { cwd: dir, limit: 50 })
  assert.ok(first.baselined >= 1, `应建立基线，实际：${JSON.stringify(first)}`)
  assert.equal(readState(store, unit.id).state, 'ok')

  // 改文件 → changed
  writeFileSync(file, 'version 2 changed')
  const second = verifyArtifacts(store, { cwd: dir, limit: 50 })
  assert.ok(second.changed >= 1, `应检出变更，实际：${JSON.stringify(second)}`)
  assert.equal(readState(store, unit.id).state, 'changed')

  // 删文件 → missing
  rmSync(file)
  const third = verifyArtifacts(store, { cwd: dir, limit: 50 })
  assert.ok(third.missing >= 1, `应检出缺失，实际：${JSON.stringify(third)}`)
  assert.equal(readState(store, unit.id).state, 'missing')

  // advisory only：条目本身不受影响
  const after = store.getUnit(unit.id)
  assert.equal(after.status, 'active', '不得因产物失效而归档')
  assert.equal(Number(after.importance), importance0, '不得因产物失效而改权重')
  closeDb(db)
})

test('首轮就缺的文件立刻记 missing（不能因为 null 被当成"没见过"而永远报 ok）', () => {
  const { db, store } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'memcore-art-miss-'))
  const gone = join(dir, 'never-existed.js')
  const unit = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: `证据在 \`${gone}\`。` })
  const first = verifyArtifacts(store, { cwd: dir, limit: 20 })
  assert.ok(first.missing >= 1, `首轮就该判缺失，实际：${JSON.stringify(first)}`)
  assert.equal(readState(store, unit.id).state, 'missing')
  closeDb(db)
})

test('敏感目录：unit 级断言必须在「不读」上（不只靠 missing===0）', () => {
  const sshPath = join(homedir(), '.ssh', 'id_rsa')
  // 直接对 fingerprint 断言，而不是绕道 verifyArtifacts——否则只要路径抽取出点别的噪声，
  // missing===0 就会假性通过，测不出「敏感文件真的被读了」这件事（上一版就吃了这个亏）
  const fp = fingerprint(sshPath)
  assert.ok(fp, '应返回探测结果')
  assert.equal(fp.skipped, 'sensitive', `敏感路径必须跳过，实际：${JSON.stringify(fp)}`)
  assert.equal(fp.sha1, null, '绝不能算出哈希')
  assert.equal(fp.size, null, '连大小都不该给')
})

test('软链一律不跟随', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memcore-art-link-'))
  const target = join(dir, 'real.js')
  writeFileSync(target, 'real content')
  const link = join(dir, 'link.js')
  symlinkSync(target, link)
  const fp = fingerprint(link, { cwd: dir })
  assert.equal(fp.skipped, 'symlink', `软链必须跳过，实际：${JSON.stringify(fp)}`)
})

test('超大文件跳过且不读全文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memcore-art-big-'))
  const big = join(dir, 'big.js')
  writeFileSync(big, 'x'.repeat(300 * 1024))
  const fp = fingerprint(big, { cwd: dir })
  assert.equal(fp.skipped, 'too-large')
  assert.equal(fp.sha1, null)
})

test('相对路径没有 cwd 时连探测都不做（checked===0，不只是 missing===0）', () => {
  const { db, store } = fixture()
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '改动在 `lib/whatever-nonexistent.js` 里。' })
  const res = verifyArtifacts(store, { limit: 20 })
  assert.equal(res.checked, 0, '无 cwd 的相对路径连 stat 都不该发生')
  assert.equal(res.missing, 0)
  closeDb(db)
})

test('轮转：OFFSET 推进，全库最终都能被核对到（不再只查最近 N 条）', () => {
  const { db, store } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'memcore-art-rot-'))
  for (let i = 0; i < 5; i += 1) {
    const f = join(dir, `f${i}.js`)
    writeFileSync(f, `x${i}`)
    store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: `文件 \`${f}\` 已写入。` })
  }
  const seen = new Set()
  for (let round = 0; round < 6; round += 1) {
    verifyArtifacts(store, { cwd: dir, limit: 2 })
    seen.add(store.getMeta('artifact_offset', '0'))
  }
  assert.ok(seen.size > 1, '偏移应轮转，而不是永远停在同一批')
  // 标题声称的「全库都能被核对到」必须真的验：5 条都应有状态
  const withState = store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'artifact:%'").get()
  assert.equal(Number(withState.n), 5, `轮转后 5 条都该被覆盖，实际 ${withState.n}`)
  closeDb(db)
})

test('artifactStats 是真正的消费方：统计 ok/changed/missing', () => {
  const { db, store } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'memcore-art-stat-'))
  const okFile = join(dir, 'ok.js')
  writeFileSync(okFile, 'a')
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: `文件 \`${okFile}\`。` })
  verifyArtifacts(store, { cwd: dir, limit: 20 })
  const stats = artifactStats(store)
  assert.ok(stats.total >= 1, `应统计到已建指纹的条目，实际：${JSON.stringify(stats)}`)
  assert.ok(stats.ok >= 1)
  closeDb(db)
})

test('N1：反引号包裹的路径不得产生尾反引号变体（否则永远报 missing）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memcore-art-bt-'))
  const file = join(dir, 'package.json')
  writeFileSync(file, '{"name":"x"}')
  // 本插件自己的记忆正文大量是这个形态
  const paths = candidatePaths(`迁移在 \`${file}\` 里，作者 zhe.chen。`)
  assert.ok(!paths.some((x) => x.endsWith('`')), `不得产出尾反引号变体，实际：${JSON.stringify(paths)}`)
  assert.ok(!paths.includes('zhe.chen'), '点分小写词不得当文件')
  assert.ok(paths.includes(file), '本体路径必须保留')

  const { db, store } = fixture()
  const unit = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: `迁移在 \`${file}\` 里。` })
  const res = verifyArtifacts(store, { cwd: dir, limit: 20 })
  assert.equal(res.missing, 0, `文件真实存在，不得判缺失（实际 ${JSON.stringify(res)}）`)
  assert.equal(JSON.parse(store.getMeta(`artifact:${unit.id}`, '{}')).state, 'ok')
  closeDb(db)
})

test('N3：中文注释紧贴路径不得被吃进路径（假 missing 的头号来源）', () => {
  const cases = [
    '/Users/x/.dsh/profiles/desktop/cordis.yml`（组合快照总条目',
    '/Users/x/.dsh/profiles/desktop/compatibility.json`（按宿主版本逐条的豁免台账',
    '~/Desktop/proj/report.md（260 行，含图表',
  ]
  for (const line of cases) {
    const got = candidatePaths(line)
    assert.ok(!got.some((p) => /[\u4e00-\u9fff（）：；，。」]/.test(p)), `路径里不该含中文/全角标点：${JSON.stringify(got)}`)
  }
})

test('N3：无扩展名（真实路径含空格被截断）与文档占位符都不认', () => {
  assert.equal(candidatePaths('/Users/x/Library/Application').length, 0, '被空格截断的路径不认')
  assert.equal(candidatePaths('/Users/x/.dsh/profiles/<profile>/node_modules').length, 0, '占位符不认')
  assert.equal(candidatePaths('/Users/x/.dsh/sessions/.../session.v4.jsonl.zstd').length, 0, '省略号占位符不认')
})

test('N3：正常路径仍然保留（不过度收紧）；裸文件名因有歧义而不认', () => {
  const got = candidatePaths('改动在 `lib/schema.js`，另见 `src/a/b.ts`。')
  assert.ok(got.includes('lib/schema.js'), `实际：${JSON.stringify(got)}`)
  assert.ok(got.includes('src/a/b.ts'))
  // 裸 `package.json` 机器上几十个，拿 cwd 猜会误判，所以不认
  assert.ok(!candidatePaths('配置见 `package.json`。').includes('package.json'))
})

test('N3：glob 通配符不是具体文件，不参与指纹', () => {
  assert.equal(candidatePaths('/Users/x/Desktop/figma-exports/*.ws.json').length, 0, 'glob 不认')
  assert.equal(candidatePaths('/Users/x/docs/*.md').length, 0, 'glob 不认')
})
