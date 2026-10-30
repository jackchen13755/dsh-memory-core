import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { InjectionLedger, renderRecallSection } from '../lib/inject.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

/**
 * P0-4：注入水位持久化（对齐 rofm 的 recall-state 快照）。
 *
 * `seen` 以前是纯内存 Set：重启/热重载后同一批卡片会原样再推一遍（白花 400 token 预算），
 * `missedStreak` 也归零 → `idleTurnsStop` 的省 token 保护在"反复重启的长会话"里失效。
 * 修法：只把 **id** 落 `meta` KV 表（键 `inject:seen:<sessionId>`，FIFO 上限 200），零迁移。
 */
function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-seen-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  store.insertUnit({
    track: 'memory',
    scope: 'global',
    kind: 'fact',
    content: 'Figma 设计稿用 figma_read_node_ws 读取，不要用浏览器工具。',
    meta: { ent: ['figma_read_node_ws'] },
  })
  return { db, store, recall: new Recall(store) }
}

test('seen 水位持久化：换一个 ledger 实例仍认得已注入 id（重启不重推）', () => {
  const { db, store, recall } = fixture()
  const a = new InjectionLedger({ store })
  a.noteUserMessage('p1', 'figma 设计稿怎么读')
  const first = renderRecallSection({ store, recall, ledger: a, sessionId: 'p1', cwd: null, config: {} })
  assert.equal(first.injected, true)
  const ids = first.ids ?? []
  assert.ok(ids.length >= 1)

  // 模拟重启：新实例（内存态清空），同一个库
  const b = new InjectionLedger({ store })
  b.noteUserMessage('p1', 'figma 设计稿怎么读')
  const second = renderRecallSection({ store, recall, ledger: b, sessionId: 'p1', cwd: null, config: {} })
  assert.equal(second.injected, false)
  assert.equal(second.reason, 'all-seen', '重启后同一批卡片不得重推')
  assert.deepEqual([...b.session('p1').seen].sort(), [...ids].sort())

  // 水位存在 meta 表，且只有 id（不存正文）
  const raw = store.getMeta(`inject:seen:p1`)
  assert.ok(raw && raw.startsWith('['))
  assert.ok(!raw.includes('figma_read_node_ws'), '水位只存 id，不存正文')
  closeDb(db)
})

test('store=null（或 persistSeen=false）时退回纯内存态：与旧行为逐位一致', () => {
  const { db, store, recall } = fixture()
  const a = new InjectionLedger()
  a.noteUserMessage('p2', 'figma 设计稿怎么读')
  const first = renderRecallSection({ store, recall, ledger: a, sessionId: 'p2', cwd: null, config: {} })
  assert.equal(first.injected, true)
  const b = new InjectionLedger()
  b.noteUserMessage('p2', 'figma 设计稿怎么读')
  const second = renderRecallSection({ store, recall, ledger: b, sessionId: 'p2', cwd: null, config: {} })
  assert.equal(second.injected, true, '不持久化时新实例从头开始（旧行为）')

  const c = new InjectionLedger({ store, persistSeen: false })
  c.markSeen('p3', ['x1'])
  assert.equal(store.getMeta('inject:seen:p3'), null, 'persistSeen=false 不写 meta')
  closeDb(db)
})

test('水位上限：超出 seenCap 只保留最后一截（FIFO）', () => {
  const { db, store } = fixture()
  const led = new InjectionLedger({ store, seenCap: 5 })
  led.markSeen('p4', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  const arr = JSON.parse(store.getMeta('inject:seen:p4'))
  assert.deepEqual(arr, ['c', 'd', 'e', 'f', 'g'])
  assert.equal(led.session('p4').seen.size, 7, '内存态仍是完整的 7 条')
  closeDb(db)
})

test('水位坏 JSON 只丢水位，不影响注入', () => {
  const { db, store, recall } = fixture()
  store.setMeta('inject:seen:bad', '{ 不是 JSON')
  const led = new InjectionLedger({ store })
  led.noteUserMessage('bad', 'figma 设计稿怎么读')
  const res = renderRecallSection({ store, recall, ledger: led, sessionId: 'bad', cwd: null, config: {} })
  assert.equal(res.injected, true, '坏水位不得连累注入')
  closeDb(db)
})
