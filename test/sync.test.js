import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
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
