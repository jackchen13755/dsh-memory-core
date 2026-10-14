import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { sha1 } from '../lib/paths.js'
import { Store } from '../lib/store.js'
import { SyncEngine } from '../lib/sync.js'
import { TodoManager } from '../lib/todos.js'

/** 造一台"设备"：独立 DB + 指定 deviceId；所有设备共用同一个 changes 目录（模拟 git 仓库）。 */
function device(root, id) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), `memcore-${id}-`)), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  store.setMeta('device_id', id)
  store.device = id // Store 在构造时读设备 id；测试里显式覆盖（真实场景由 meta 决定）
  const engine = new SyncEngine(store, { dir: join(root, 'changes') })
  return { id, db, store, engine, sync: (other) => { engine.exportChanges(); other.engine.exportChanges(); return other.engine.importChanges() } }
}

function contents(store, scope = 'global') {
  return store.db
    .prepare("SELECT content FROM units WHERE status = 'active' AND scope = ? ORDER BY content")
    .all(scope)
    .map((r) => r.content)
}

test('双机演练：各自新增 → 互导后双方状态收敛（git 只搬日志，不搬库）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')

  a.store.insertUnit({ track: 'memory', scope: 'global', content: 'A 机写下的事实：端口 8080。' })
  b.store.insertUnit({ track: 'key', scope: 'global', content: 'B 机写下的约定：提交信息用中文。' })

  const r1 = a.sync(b) // A 导出 → B 导入
  const r2 = b.sync(a) // B 导出 → A 导入
  assert.equal(r1.applied, 1, JSON.stringify(r1))
  assert.equal(r2.applied, 1, JSON.stringify(r2))

  assert.deepEqual(contents(a.store), contents(b.store), '两台设备的 active 条目内容集合应一致')
  assert.equal(contents(a.store).length, 2)
  // 每台设备只写自己的文件 → 目录里只有两个文件，git 永不冲突
  const files = readdirSync(join(root, 'changes')).filter((f) => f.endsWith('.jsonl')).sort()
  assert.deepEqual(files, ['changes-devA.jsonl', 'changes-devB.jsonl'])
  closeDb(a.db)
  closeDb(b.db)
})

test('双机演练：重复导入幂等（再导一次不产生副本）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync2-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')
  a.store.insertUnit({ track: 'memory', scope: 'global', content: '一条会被反复导入的记忆。' })
  a.sync(b)
  const before = b.store.counts().units
  for (let i = 0; i < 3; i += 1) b.engine.importChanges()
  assert.equal(b.store.counts().units, before, '幂等：重复导入不得新增条目')
  closeDb(a.db)
  closeDb(b.db)
})

test('双机演练：同 lamport 不同内容 → 冲突双留（两边内容集合一致、不静默覆盖）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync3-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')
  const shared = a.store.insertUnit({ track: 'key', scope: 'global', content: '部署方式是 docker compose。' })
  a.sync(b)
  b.engine.importChanges()
  assert.equal(b.store.getUnit(shared.id).content, '部署方式是 docker compose。', '先同步基线')

  // 两台设备在同一个 lamport 上各自改这条（离线并行编辑）
  a.store.updateUnit(shared.id, { content: '部署方式改成 k8s（A 机改的）。' })
  b.store.updateUnit(shared.id, { content: '部署方式仍用 docker compose（B 机改的）。' })

  a.engine.exportChanges()
  b.engine.exportChanges()
  const ra = a.engine.importChanges()
  const rb = b.engine.importChanges()
  assert.ok(ra.conflicts + rb.conflicts >= 1, `应各留一份冲突：${JSON.stringify(ra)} / ${JSON.stringify(rb)}`)

  assert.deepEqual(contents(a.store), contents(b.store), '冲突后两边内容集合仍应一致（双留）')
  assert.equal(contents(a.store).length, 2, '两个版本都在，谁也不丢')
  const edge = a.store.db.prepare("SELECT * FROM edges WHERE kind = 'contradicts'").get()
  assert.ok(edge, '应建 contradicts 边标记冲突')
  const pending = a.store.listSuggestions({ status: 'pending' })
  assert.ok(pending.some((s) => String(s.payload).includes('同步冲突')), '应进待确认队列等人工裁决')
  closeDb(a.db)
  closeDb(b.db)
})

test('双机演练：删除传播 + lamport 新者胜（不复活旧内容）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync4-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')
  const u = a.store.insertUnit({ track: 'memory', scope: 'global', content: '这条待会儿删掉。' })
  a.sync(b)
  b.engine.importChanges()
  assert.equal(b.store.getUnit(u.id).content, '这条待会儿删掉。')

  a.store.updateUnit(u.id, { content: 'A 机改过的新版本。' })
  a.engine.exportChanges()
  b.engine.importChanges()
  assert.equal(b.store.getUnit(u.id).content, 'A 机改过的新版本。', 'lamport 更大者胜（LWW）')
  closeDb(a.db)
  closeDb(b.db)
})

test('双机演练：待办也随日志同步（实体级 lamport）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync5-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')
  const todos = new TodoManager(a.store)
  const added = todos.add({ content: '把同步演练写进文档', track: 'work', due: '2026-09-30' })
  assert.equal(added.ok, true)
  a.sync(b)
  const row = b.store.db.prepare('SELECT * FROM todos WHERE id = ?').get(added.id)
  assert.ok(row, '待办应同步到 B 机')
  assert.equal(row.content, '把同步演练写进文档')
  closeDb(a.db)
  closeDb(b.db)
})

test('同步状态：游标、待导出计数、文件清单', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync6-'))
  const a = device(root, 'devA')
  a.store.insertUnit({ track: 'memory', scope: 'global', content: '一条用于状态检查的记忆。' })
  const before = a.engine.status()
  assert.ok(before.pendingExport >= 1)
  a.engine.exportChanges()
  const after = a.engine.status()
  assert.equal(after.pendingExport, 0)
  assert.equal(after.files.length, 1)
  assert.equal(after.files[0].mine, true)
  assert.ok(readFileSync(join(root, 'changes', 'changes-devA.jsonl'), 'utf8').includes('"entity":"unit"'))
  closeDb(a.db)
})

test('同步：occurred_at 随变更日志走（导入不丢、对端缺键不抹本地值、冲突副本带上）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync7-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')
  const when = new Date(2026, 9, 14, 10, 0, 0).getTime()
  const id = a.store.insertUnit({ track: 'memory', scope: 'global', content: '带事件时间的记忆：2026-10-14 定了目录约定。' }).id
  a.store.db.prepare('UPDATE units SET occurred_at = ? WHERE id = ?').run(when, id)

  const r1 = a.sync(b)
  assert.equal(r1.applied, 1, JSON.stringify(r1))
  assert.equal(
    b.store.db.prepare('SELECT occurred_at FROM units WHERE id = ?').get(id).occurred_at,
    when,
    'occurred_at 必须随日志同步（导入列清单漏列会把它静默写成 NULL）',
  )

  // 对端是**旧版本**：日志行里根本没有这个键 → 不得抹掉本地已有的事件时间（其余列仍按 LWW 覆盖）
  const remoteRow = b.store.db.prepare('SELECT * FROM units WHERE id = ?').get(id)
  delete remoteRow.occurred_at
  remoteRow.content = '带事件时间的记忆：对端旧版本改过的正文。'
  b.engine.upsertRow('unit', remoteRow)
  const after = b.store.db.prepare('SELECT occurred_at, content FROM units WHERE id = ?').get(id)
  assert.equal(after.occurred_at, when, '对端行缺这个键时不得抹掉本地值')
  assert.equal(after.content, '带事件时间的记忆：对端旧版本改过的正文。', '其余列仍照常覆盖')

  // 冲突双留的副本也要继承事件时间（否则人工裁决时会丢掉"这件事什么时候发生"）
  const conflictContent = '带事件时间的记忆：另一个版本。'
  const conflictRow = {
    ...b.store.db.prepare('SELECT * FROM units WHERE id = ?').get(id),
    content: conflictContent,
    content_hash: sha1(conflictContent), // 与 store.insertUnit 同款：content_hash = sha1(content)
    occurred_at: when,
  }
  const kept = b.engine.keepBoth({ entity: 'unit', id, device: 'devZ', lamport: 99, row: conflictRow })
  assert.equal(kept, true)
  const copies = b.store.db.prepare('SELECT occurred_at FROM units WHERE source_file = ?').all('sync:devZ')
  assert.equal(copies.length, 1)
  assert.equal(copies[0].occurred_at, when, '冲突副本必须带上事件时间')
  closeDb(a.db)
  closeDb(b.db)
})

test('同步：对端删除条目后不留 FTS 孤儿行（deleteRow 曾抛 no such column: id）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync8-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')
  const id = a.store.insertUnit({ track: 'memory', scope: 'global', content: '会被对端删掉的记忆条目。' }).id
  a.sync(b)
  assert.ok(b.store.db.prepare('SELECT id FROM units WHERE id = ?').get(id), '先确认条目已同步到 B')

  // A 机时钟推进后再删除（lamport 必须严格更大，删除才会被采纳）
  a.store.observeLamport(99)
  a.store.db.prepare('DELETE FROM units WHERE id = ?').run(id)
  a.store.logChange('unit', id, 'delete', {})

  const r = a.sync(b)
  assert.equal(r.applied, 1, JSON.stringify(r))
  assert.equal(b.store.db.prepare('SELECT id FROM units WHERE id = ?').get(id), undefined, '删除应传到 B')
  const orphans = b.store.db.prepare('SELECT COUNT(*) AS n FROM units_fts WHERE rowid NOT IN (SELECT rowid FROM units)').get().n
  assert.equal(orphans, 0, 'FTS 孤儿行会让检索命中已删除的条目（且 deleteRow 会先抛异常中断整次导入）')
  closeDb(a.db)
  closeDb(b.db)
})

test('同步：冲突双留之后再导入一次不抛错、不中断（content_hash 唯一索引冲突）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync9-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')
  const id = a.store.insertUnit({ track: 'memory', scope: 'global', content: '同一件事的初版描述。' }).id
  a.sync(b)

  // 双方在**同 lamport** 下各改各的 → 触发冲突双留（这是文档化的正常流程，不是异常）
  a.store.updateUnit(id, { content: '同一件事：A 机版本。' })
  b.store.updateUnit(id, { content: '同一件事：B 机版本。' })
  const r2 = b.sync(a)
  assert.equal(r2.ok, true, JSON.stringify(r2))
  assert.ok(r2.conflicts >= 1, `同 lamport 不同内容应触发双留：${JSON.stringify(r2)}`)

  // 关键回归：冲突副本会带着"对端已有的同一份内容"回流，此时 `units_content_hash` 唯一索引冲突。
  // 旧的 INSERT OR REPLACE 靠隐式删除兜底；换成 ON CONFLICT(id) 后若不显式处理，
  // 这里抛 UNIQUE constraint failed → 导入循环没有逐行兜底时整次中断、该行永远留在日志里
  // → 每次重导都抛 = 同步永久死锁（且没有任何报告留痕）。
  const r3 = a.sync(b)
  assert.equal(r3.ok, true)
  assert.equal(r3.errored ?? 0, 0, `导入不该有坏行：${JSON.stringify(r3.errors ?? [])}`)
  assert.equal(
    r3.applied + r3.skipped + r3.conflicts + r3.bad,
    r3.scanned,
    '每一行都必须有归属（说明没有被中断）',
  )
  const orphansA = a.store.db.prepare('SELECT COUNT(*) AS n FROM units_fts WHERE rowid NOT IN (SELECT rowid FROM units)').get().n
  assert.equal(orphansA, 0, '被顶掉那行的 FTS 行要一起清掉（REPLACE 会留孤儿）')

  // 再来一轮：修复前这里每次都会抛，等于同步永久死锁
  const r4 = b.sync(a)
  assert.equal(r4.errored ?? 0, 0, `重导必须可重复且不抛：${JSON.stringify(r4.errors ?? [])}`)
  const orphansB = b.store.db.prepare('SELECT COUNT(*) AS n FROM units_fts WHERE rowid NOT IN (SELECT rowid FROM units)').get().n
  assert.equal(orphansB, 0)
  closeDb(a.db)
  closeDb(b.db)
})

test('同步：显式清空 occurred_at 必须传播（只有「日志行缺这个键」才该兜底）', () => {
  const root = mkdtempSync(join(tmpdir(), 'memcore-sync10-'))
  const a = device(root, 'devA')
  const b = device(root, 'devB')
  const when = new Date(2026, 9, 14, 10, 0, 0).getTime()
  const id = a.store.insertUnit({ track: 'memory', scope: 'global', content: '先带上事件时间的记忆。' }).id
  a.store.db.prepare('UPDATE units SET occurred_at = ? WHERE id = ?').run(when, id)
  a.sync(b)
  assert.equal(b.store.db.prepare('SELECT occurred_at FROM units WHERE id = ?').get(id).occurred_at, when)

  // 清空（等价于 mem_update 传 occurredAt: null）：updateUnit 会 tick lamport 并记变更日志
  a.store.db.prepare('UPDATE units SET occurred_at = NULL WHERE id = ?').run(id)
  a.store.updateUnit(id, { content: '正文改过一次、事件时间已清空的记忆。' })
  a.sync(b)
  assert.equal(
    b.store.db.prepare('SELECT occurred_at FROM units WHERE id = ?').get(id).occurred_at,
    null,
    '显式清空必须传播（无条件 COALESCE 会把本地旧值留住 → 两台设备两个时间）',
  )
  closeDb(a.db)
  closeDb(b.db)
})
