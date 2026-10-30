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
 * P0-1：召回记账**双计数**。
 *
 * 历史上有两个入口对同一轮各记一次：`renderRecallSection` 内部一次，
 * 注册段外层（`index.js`）再一次。后果不是崩溃，而是：
 *   - 一轮未命中被记成 2 次空转 → `idleTurnsStop:5` 实际第 3 轮就停；
 *   - `totals.recallTokens` / `hitTurns` 虚高。
 * 修法是给 `noteRecall` 加幂等键（`turns|queryAt`）。
 */
function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-ledger-')), 'mem.db'))
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

test('noteRecall 幂等：同一轮两次记账只算一次', () => {
  const led = new InjectionLedger()
  led.noteUserMessage('s1', '同一轮')
  const first = led.noteRecall('s1', { tokens: 100, cards: 2, injected: true })
  const second = led.noteRecall('s1', { tokens: 100, cards: 2, injected: true })
  assert.equal(first, true)
  assert.equal(second, false, '第二次必须被幂等挡住')
  const snap = led.snapshot('s1')
  assert.equal(snap.totals.recallTokens, 100, 'token 账不得翻倍')
  assert.equal(snap.totals.cards, 2)
  assert.equal(snap.session.hitTurns, 1)
})

test('一轮未命中只累加 1：idleTurnsStop=5 要 5 轮才停', () => {
  const led = new InjectionLedger()
  for (let i = 1; i <= 5; i += 1) {
    led.noteUserMessage('s2', `第 ${i} 轮`)
    led.noteRecall('s2', { tokens: 0, cards: 0, injected: false, evidence: false, reason: 'evidence-below-threshold' })
    // 模拟"段内 + 注册段外层"两个入口对同一轮各调一次
    led.noteRecall('s2', { tokens: 0, cards: 0, injected: false, evidence: false, reason: 'evidence-below-threshold' })
    assert.equal(led.snapshot('s2').session.missedStreak, i, `第 ${i} 轮后空转计数应为 ${i}（不是 ${i * 2}）`)
  }
})

test('renderRecallSection + 外层重复记账：一轮只算一次空转，第 6 轮才 idle-stop', () => {
  const { db, store, recall } = fixture()
  const ledger = new InjectionLedger()
  const sessionId = 's3'
  const render = () => {
    ledger.noteUserMessage(sessionId, 'zzz 完全无关的查询内容')
    const res = renderRecallSection({ store, recall, ledger, sessionId, cwd: null, config: {} })
    ledger.noteRecall(sessionId, res) // index.js 的那个入口
    return res
  }
  for (let i = 0; i < 5; i += 1) {
    const res = render()
    assert.notEqual(res.reason, 'idle-stop', `第 ${i + 1} 轮不该已经停`)
  }
  assert.equal(ledger.snapshot(sessionId).session.missedStreak, 5)
  const stopped = render()
  assert.equal(stopped.reason, 'idle-stop', '第 6 轮应停（idleTurnsStop=5）')
  closeDb(db)
})

test('reason=off / no-query / idle-stop 不计数（关掉该段或还没人说话不算空转）', () => {
  const led = new InjectionLedger()
  led.noteUserMessage('s4', '有 query')
  assert.equal(led.noteRecall('s4', { reason: 'off' }), false)
  assert.equal(led.noteRecall('s4', { reason: 'no-query' }), false)
  assert.equal(led.noteRecall('s4', { reason: 'idle-stop' }), false)
  assert.equal(led.snapshot('s4').session.missedStreak, 0)
})
