import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { EVOLVE_DEFAULTS, WriteWatchdog, decay, reconcile, reinforce, runEvolution } from '../lib/evolution.js'
import { Store } from '../lib/store.js'
import { writeMemory } from '../lib/writer.js'
import { Recall } from '../lib/recall.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-evo-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  return { db, store, recall: new Recall(store) }
}

test('强化：被召回过的条目加权，同批召回建 coRetrieval 边', () => {
  const { db, store } = fixture()
  const a = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '规则A：提交前跑 lint。' })
  const b = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '规则B：提交信息用中文。' })
  const before = Number(store.getUnit(a.id).importance)
  const ts = Date.now()
  const ins = store.db.prepare(
    'INSERT INTO recall_log (ts, session_id, query, unit_id, channel, rank, score, injected, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run(ts, 's1', 'lint 规则', a.id, 'lexical+sparse', 1, 0.9, 1, '两通道命中')
  ins.run(ts, 's1', 'lint 规则', b.id, 'lexical', 2, 0.5, 1, null)
  const res = reinforce({ store })
  assert.equal(res.ok, true)
  assert.ok(res.boosted >= 1)
  assert.ok(Number(store.getUnit(a.id).importance) > before, '被取回的应加权')
  const edge = store.db.prepare("SELECT * FROM edges WHERE kind = 'coRetrieval'").get()
  assert.ok(edge, '同批召回应建边')
  closeDb(db)
})

test('衰减：按半衰期下降，低于阈值转 archived；pin 豁免；只归档不删除', () => {
  const { db, store } = fixture()
  const old = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '很久没用的旧事实。' })
  const pinned = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '置顶规则不该被衰减。', pinned: 1 })
  const longAgo = Date.now() - 400 * 86400000
  store.db.prepare('UPDATE units SET importance = 0.5, last_accessed = ?, updated_at = ?, created_at = ? WHERE id = ?').run(longAgo, longAgo, longAgo, old.id)
  store.db.prepare('UPDATE units SET importance = 0.5, last_accessed = ? WHERE id = ?').run(longAgo, pinned.id)

  const res = decay({ store })
  assert.equal(res.ok, true)
  const afterOld = store.getUnit(old.id)
  assert.ok(Number(afterOld.importance) < 0.5, '应衰减')
  assert.equal(afterOld.status, 'archived', '低于阈值应归档')
  assert.equal(store.getUnit(pinned.id).status, 'active', 'pin 豁免')
  assert.ok(Number(store.getUnit(pinned.id).importance) === 0.5)
  assert.ok(store.getUnit(old.id) !== null, '归档不是删除')
  closeDb(db)
})

test('衰减宽限期：新建/刚导入的记忆不参与衰减（避免首次巡演把历史资产判死）', () => {
  const { db, store } = fixture()
  const fresh = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '刚写入的一条记忆。' })
  store.db.prepare('UPDATE units SET importance = 0.2, last_accessed = NULL, updated_at = ?, created_at = ? WHERE id = ?').run(
    Date.now() - 10 * 86400000,
    Date.now() - 10 * 86400000,
    fresh.id,
  )
  const res = decay({ store })
  assert.equal(res.archived, 0, '10 天前创建、宽限期内不应被归档')
  assert.equal(store.getUnit(fresh.id).status, 'active')
  assert.equal(Number(store.getUnit(fresh.id).importance), 0.2, '也不应被衰减')

  // 超过宽限期后才参与
  store.db.prepare('UPDATE units SET created_at = ?, updated_at = ?, last_accessed = NULL, importance = 0.2 WHERE id = ?').run(
    Date.now() - 120 * 86400000,
    Date.now() - 120 * 86400000,
    fresh.id,
  )
  const res2 = decay({ store })
  assert.ok(res2.archived >= 1, '超期后应被归档')
  closeDb(db)
})

test('调和：高度相似的同一件事合并（旧条目 superseded 且留版本链），数字不同的判为冲突成对保留', () => {
  const { db, store } = fixture()
  const first = store.insertUnit({ track: 'key', scope: 'project:abc', kind: 'env', content: '本机 node 版本是 v26，自带 node:sqlite 与 FTS5。' })
  const dup = store.insertUnit({ track: 'key', scope: 'project:abc', kind: 'env', content: '本机 node 版本是 v26，自带 node:sqlite 和 FTS5 支持。' })
  const conflictA = store.insertUnit({ track: 'key', scope: 'project:abc', kind: 'env', content: '服务端口是 8080，部署用 docker。' })
  const conflictB = store.insertUnit({ track: 'key', scope: 'project:abc', kind: 'env', content: '服务端口是 9090，部署用 docker。' })

  const res = reconcile({ store })
  assert.equal(res.ok, true)
  assert.ok(res.merged >= 1, `应合并至少一对：${JSON.stringify(res)}`)
  const statuses = [first.id, dup.id].map((id) => store.getUnit(id).status)
  assert.ok(statuses.includes('superseded'), '保留一条、另一条标记取代')
  const supersededRow = store.db.prepare("SELECT * FROM units WHERE status = 'superseded'").get()
  assert.ok(supersededRow.superseded_by, '应记录取代链')
  assert.equal(store.getUnit(conflictA.id).status, 'active')
  assert.equal(store.getUnit(conflictB.id).status, 'active')
  const contradicts = store.db.prepare("SELECT * FROM edges WHERE kind = 'contradicts'").get()
  assert.ok(contradicts, '冲突应建 contradicts 边并以成对保留')
  closeDb(db)
})

test('演化巡演：单步失败不影响其余步骤，报告落 meta', () => {
  const { db, store } = fixture()
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '随便一条。' })
  return runEvolution({ store }).then((report) => {
    assert.ok(report.steps.length >= 3, '至少跑强化/调和/衰减三步')
    const meta = JSON.parse(store.getMeta('evolve_last_run'))
    assert.equal(meta.steps.length, report.steps.length)
    closeDb(db)
  })
})

test('写入看门狗：默认关；开启后连续 N 轮未写就提醒，写入即消', () => {
  const off = new WriteWatchdog()
  off.noteTurn('s')
  off.noteTurn('s')
  assert.equal(off.warningFor('s'), null, '默认关闭')

  const wd = new WriteWatchdog({ enabled: true, threshold: 2 })
  wd.noteTurn('s')
  assert.equal(wd.warningFor('s'), null, '第一轮不提醒')
  wd.noteTurn('s')
  const warn = wd.warningFor('s')
  assert.ok(warn && warn.includes('连续 2 轮'), `实际：${warn}`)
  wd.noteWrite('s')
  assert.equal(wd.warningFor('s'), null, '写入即消')
})

test('看门狗与真实写入路径联动（mem_write 消警）', () => {
  const { db, store, recall } = fixture()
  const wd = new WriteWatchdog({ enabled: true, threshold: 1 })
  wd.noteTurn('s-1')
  assert.ok(wd.warningFor('s-1'))
  writeMemory({ store, recall, cwd: null, input: { content: '本回合的进展记录。', track: 'project', kind: 'progress' }, origin: 'session:s-1' })
  const m = /^session:(.+)$/.exec('session:s-1')
  wd.noteWrite(m[1])
  assert.equal(wd.warningFor('s-1'), null)
  closeDb(db)
})

test('默认配置与设计一致（衰减 30 天、归档阈值 0.15、看门狗默认关）', () => {
  assert.equal(EVOLVE_DEFAULTS.decayHalfLifeDays, 30)
  assert.equal(EVOLVE_DEFAULTS.archiveBelow, 0.15)
  assert.equal(EVOLVE_DEFAULTS.writeGuard.enabled, false)
  assert.equal(EVOLVE_DEFAULTS.llm.abstract, false, 'LLM 抽象默认关')
})

// ---------------------------------------------------------------------------
// M5：C4 图通道（PPR）
// ---------------------------------------------------------------------------

test('图通道：能捞出"词面没命中、但被同批取回/显式关联过"的条目', async () => {
  const { closeDb: cd, migrate: mg, openDb: od } = await import('../lib/db.js')
  const { Recall: R } = await import('../lib/recall.js')
  const { Store: S } = await import('../lib/store.js')
  const db = od(':memory:')
  mg(db)
  const store = new S(db)
  // 小样本：把边数门槛与冷启动门槛调低（生产默认 20 边 / 50 条）
  const recall = new R(store, { coldStartUnits: 0, channels: { graph: { enabled: true, weight: 0.6, minEdges: 1, seedCount: 8 } } })

  // A：查询词面命中；B：与 A 无共同词，但被同批取回过；C：只有一条链路（B—C）
  const a = store.insertUnit({ track: 'memory', scope: 'global', content: '搜索插件已换成 AnySearch，走 /v1/search 与 /v1/extract。' })
  const b = store.insertUnit({ track: 'memory', scope: 'global', content: '该网关的密钥放在 ~/.dsh/.credentials.yaml 的 refs 里，改完无需重启。' })
  const c = store.insertUnit({ track: 'key', scope: 'global', content: '本机凭据文件由 credentials-local 热刷新，落盘即生效。' })
  const ins = db.prepare('INSERT INTO edges (from_id, to_id, kind, weight) VALUES (?, ?, ?, ?)')
  ins.run(a.id, b.id, 'coRetrieval', 1)
  ins.run(b.id, c.id, 'association', 0.8)

  // 词法/稀疏通道：只有 A 命中（B、C 无共同词）
  const lexical = recall.channelLexical('AnySearch 搜索插件', { scopes: 'all', limit: 10 })
  assert.ok(lexical.some((h) => h.id === a.id), 'A 应被词法命中')
  assert.ok(!lexical.some((h) => h.id === b.id), 'B 不应被词法命中（这是前提）')

  const graph = recall.channelGraph('AnySearch 搜索插件', { scopes: 'all', limit: 10 })
  const ids = graph.list.map((h) => h.id)
  assert.ok(ids.includes(b.id), `B 应被图通道捞出：${JSON.stringify(ids)}`)
  assert.ok(ids.includes(c.id), '二跳的 C 也应被捞出（PPR 会沿链传播）')
  assert.ok(!ids.includes(a.id), '种子自身不再由图通道重复给出')
  assert.ok(graph.list[0].reason.includes('PPR'), graph.list[0].reason)

  // 融合后：B 进入候选集（词面完全没有它的情况下）
  const res = recall.search({ query: 'AnySearch 搜索插件', k: 8 })
  assert.ok(res.hits.some((r) => r.id === b.id), `融合结果里应出现 B：${JSON.stringify(res.hits.map((r) => r.id))}`)
  const bHit = res.hits.find((r) => r.id === b.id)
  assert.ok(bHit.channels.graph, 'B 的命中来源应标注为 graph 通道')
  cd(db)
})

test('图通道：关联边不足时明确跳过（不硬凑结果）', async () => {
  const { closeDb: cd, migrate: mg, openDb: od } = await import('../lib/db.js')
  const { Recall: R } = await import('../lib/recall.js')
  const { Store: S } = await import('../lib/store.js')
  const db = od(':memory:')
  mg(db)
  const store = new S(db)
  const recall = new R(store, { coldStartUnits: 0 })
  store.insertUnit({ track: 'memory', scope: 'global', content: '一条没有关联边的记忆。' })
  const graph = recall.channelGraph('记忆', { scopes: 'all', limit: 10 })
  assert.equal(graph.list.length, 0)
  assert.ok(graph.reason.includes('关联边不足'), graph.reason)
  const res = recall.search({ query: '记忆', k: 5 })
  assert.equal(res.channels.graph.skipped.includes('关联边不足'), true, JSON.stringify(res.channels.graph))
  cd(db)
})
