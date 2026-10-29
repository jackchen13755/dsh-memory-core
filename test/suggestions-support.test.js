import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { Store } from '../lib/store.js'
import { sweepSuggestions } from '../lib/writer.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-sug-')), 'mem.db'))
  migrate(db)
  return { db, store: new Store(db) }
}

test('支持度：同一件事被重复提出时累加 support，不产生第二行', () => {
  const { db, store } = fixture()
  const payload = { content: '提交前必须跑 node --test。', track: 'memory' }
  const first = store.insertSuggestion({ kind: 'memory', target: 'memory', payload })
  assert.equal(first.inserted, true)
  for (let i = 0; i < 2; i += 1) store.insertSuggestion({ kind: 'memory', target: 'memory', payload })
  const rows = store.listSuggestions({ status: 'pending' })
  assert.equal(rows.length, 1, '同内容只有一行')
  assert.equal(Number(rows[0].support), 3, '被提出 3 次 → support=3')
  assert.ok(rows[0].last_seen_at, '应记录最后出现时间')
  closeDb(db)
})

test('排序：support 高的排在前面（反复提出的先被看到）', () => {
  const { db, store } = fixture()
  store.insertSuggestion({ kind: 'memory', target: 'memory', payload: { content: '一次性噪声 A。' } })
  const repeated = { kind: 'memory', target: 'memory', payload: { content: '被纠正过三次的事 B。' } }
  store.insertSuggestion(repeated)
  store.insertSuggestion(repeated)
  store.insertSuggestion(repeated)
  const rows = store.listSuggestions({ status: 'pending' })
  assert.match(JSON.parse(rows[0].payload).content, /B/, 'support 高的应排第一')
  closeDb(db)
})

test('清扫豁免：support 达标的超期建议不随 14 天一刀切归档，噪声照常归档', () => {
  const { db, store } = fixture()
  const now = Date.now()
  const old = now - 30 * 86400000
  const noisy = store.insertSuggestion({ kind: 'memory', target: 'memory', payload: { content: '一次性噪声 C。' }, createdAt: old })
  const important = { kind: 'memory', target: 'memory', payload: { content: '被反复提出的 D。' }, createdAt: old }
  const kept = store.insertSuggestion(important)
  store.insertSuggestion(important)
  store.insertSuggestion(important)

  const res = sweepSuggestions({ store, autoArchiveDays: 14, now })
  assert.ok(res.archived >= 1, '噪声应被归档')
  const archivedIds = store.listSuggestions({ status: 'archived' }).map((r) => r.id)
  assert.ok(archivedIds.includes(noisy.id), '一次性噪声应被归档')
  const pendingIds = store.listSuggestions({ status: 'pending' }).map((r) => r.id)
  assert.ok(pendingIds.includes(kept.id), 'support>=3 的不应被时间一刀切掉')
  closeDb(db)
})

test('B3：同一件事跨会话/不同 origin 仍合并成一行（不再各 support=1）', () => {
  const { db, store } = fixture()
  // 真实 payload 形态：origin / cwd / relation 每次都不同，只有 content+track 稳定
  for (const [i, origin] of ['session:A#3', 'session:B#7', 'session:C#11'].entries()) {
    store.insertSuggestion({
      kind: 'memory',
      target: 'memory',
      payload: { content: '提交前必须跑 node --test。', track: 'memory', origin, cwd: `/tmp/proj${i}`, relation: { relation: 'unrelated', candidates: [{ id: `x${i}`, similarity: 0.1 + i / 100 }] } },
    })
  }
  const rows = store.listSuggestions({ status: 'pending' })
  assert.equal(rows.length, 1, `同主体应合并成一行，实际 ${rows.length} 行`)
  assert.equal(Number(rows[0].support), 3, '跨会话重复应累加支持度')
  closeDb(db)
})

test('M10：support 达标只换来更长的宽限期，不是永久免疫', () => {
  const { db, store } = fixture()
  const now = Date.now()
  const veryOld = now - 200 * 86400000
  const stale = { kind: 'memory', target: 'memory', payload: { content: '很久以前反复提过的 E。' }, createdAt: veryOld }
  const kept = store.insertSuggestion(stale)
  store.insertSuggestion(stale)
  store.insertSuggestion(stale)
  // 模拟「很久以前提过三次、之后再没提」：二级宽限看的是 last_seen_at（最后一次被提到）
  store.db.prepare('UPDATE suggestions SET last_seen_at = ? WHERE id = ?').run(veryOld, kept.id)
  // 90 天宽限期也过了 → 应当归档（不能永久挂 pending）
  sweepSuggestions({ store, autoArchiveDays: 14, now })
  assert.ok(store.listSuggestions({ status: 'archived' }).some((r) => r.id === kept.id), '超过二级宽限期仍应归档')
  closeDb(db)
})

test('M10：support 达标但在二级宽限期内不归档', () => {
  const { db, store } = fixture()
  const now = Date.now()
  const midOld = now - 30 * 86400000
  const s = { kind: 'memory', target: 'memory', payload: { content: '一个月前反复提过的 F。' }, createdAt: midOld }
  const kept = store.insertSuggestion(s)
  store.insertSuggestion(s)
  store.insertSuggestion(s)
  sweepSuggestions({ store, autoArchiveDays: 14, now })
  assert.ok(store.listSuggestions({ status: 'pending' }).some((r) => r.id === kept.id), '二级宽限期内应保留')
  closeDb(db)
})
