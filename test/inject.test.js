import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { InjectionLedger, estimateTokens, humanText, renderRecallSection, renderResidentSection, trimToBudget } from '../lib/inject.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-inject-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '提交前必须跑 lint；取数链路：内网走 fetch_page，公网走 web_search。' })
  store.insertUnit({ track: 'user', scope: 'global', kind: 'preference', content: '用户偏好中文回复，少用列表。' })
  store.insertUnit({ track: 'key', scope: 'project:abc123', kind: 'env', content: '本机 node 是 v26，node:sqlite 自带 FTS5。', meta: { summary: 'node v26 自带 FTS5' } })
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: 'Figma 设计稿用 figma_read_node_ws 读取，不要用浏览器工具。', meta: { ent: ['figma_read_node_ws'] } })
  for (let i = 1; i <= 8; i += 1) {
    store.insertUnit({ track: 'daily', scope: 'global', kind: 'progress', content: `第 ${i} 天的进展记录：做了一些前端联调。`, day: `2026-09-0${i}` })
  }
  return { db, store, cwd: '/tmp/whatever', projectScope: 'project:abc123' }
}

test('token 估算：中文与 ASCII 分别计量，且保守偏大', () => {
  assert.ok(estimateTokens('中文十个字左右的话') > 3)
  assert.equal(estimateTokens(''), 0)
  assert.ok(estimateTokens('abcdefgh') > 0)
})

test('trimToBudget 截断并给出折叠提示', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `- 第 ${i} 行中文内容`)
  const out = trimToBudget(lines, 20)
  assert.ok(out.lines.length < lines.length)
  assert.ok(out.tokens <= 20)
  assert.ok(out.lines.at(-1).includes('另有'))
  const noFold = trimToBudget(lines, 20, { foldNote: false })
  assert.ok(!noFold.lines.at(-1).includes('另有'))
})

test('常驻段：规则进"规则块"，目录按轨道优先级（key 在前、daily 限量）', () => {
  const { db, store } = fixture()
  const res = renderResidentSection({ store, cwd: '/Users/nobody/memcore-fixture', config: {} })
  // 该 fixture 的 cwd 不会命中 project:abc123，用 global 作用域断言
  assert.ok(res.text.includes('【规则与偏好（常驻，必须遵守）】'))
  assert.ok(res.text.includes('提交前必须跑 lint'))
  assert.ok(res.text.includes('用户偏好中文回复'))
  assert.ok(res.tokens <= 1200, `常驻段超预算：${res.tokens}`)
  assert.ok(res.rules >= 2, '两条规则都应常驻')
  // 规则不该重复出现在目录里（fact 类才进目录）
  const catalogPart = res.text.split('【本范围记忆目录')[1] ?? ''
  assert.ok(!catalogPart.includes('提交前必须跑 lint'))
  assert.ok(catalogPart.includes('Figma 设计稿'))
  // daily 限量：8 条日志不会全部列出
  assert.ok((catalogPart.match(/daily\]/g) ?? []).length <= 5, 'daily 目录行应限量')
  closeDb(db)
})

test('常驻段可整体关闭', () => {
  const { db, store } = fixture()
  const res = renderResidentSection({ store, cwd: null, config: { resident: { rules: false, indexCatalog: false } } })
  assert.equal(res.text, '')
  assert.equal(res.tokens, 0)
  closeDb(db)
})

test('按轮召回：无 query 不注入；有证据才注入；同轮渲染稳定；跨轮去重', () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  const ledger = new InjectionLedger()
  const sessionId = 's1'

  const noQuery = renderRecallSection({ store, recall, ledger, sessionId, cwd: null, config: {} })
  assert.equal(noQuery.injected, false)
  assert.equal(noQuery.reason, 'no-query')

  ledger.noteUserMessage(sessionId, 'figma 设计稿怎么读')
  const first = renderRecallSection({ store, recall, ledger, sessionId, cwd: null, config: {} })
  assert.equal(first.injected, true, '实体命中应有证据')
  assert.ok(first.cards >= 1)
  assert.ok(first.tokens <= 400, `按轮卡片超预算：${first.tokens}`)

  // 同一轮内多次组装：文本必须一致（否则运行时快照会抖动）
  const second = renderRecallSection({ store, recall, ledger, sessionId, cwd: null, config: {} })
  assert.equal(second.text, first.text)
  assert.equal(second.tokens, first.tokens)

  // 新的一轮、同一 query：卡片已见过 → 不再重复注入
  ledger.noteUserMessage(sessionId, 'figma 设计稿怎么读')
  const third = renderRecallSection({ store, recall, ledger, sessionId, cwd: null, config: {} })
  assert.equal(third.injected, false)
  assert.equal(third.reason, 'all-seen')

  const snap = ledger.snapshot(sessionId)
  assert.equal(snap.totals.recallSections, 1)
  assert.ok(snap.session.seenIds >= 1)
  closeDb(db)
})

test('按轮召回：连续无命中达阈值后本会话停止触发', () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  const ledger = new InjectionLedger()
  const sessionId = 's2'
  for (let i = 0; i < 5; i += 1) {
    ledger.noteUserMessage(sessionId, `完全无关的查询内容 zzz-${i}`)
    const res = renderRecallSection({ store, recall, ledger, sessionId, cwd: null, config: {} })
    assert.equal(res.injected, false)
  }
  ledger.noteUserMessage(sessionId, '再来一条完全无关的内容')
  const stopped = renderRecallSection({ store, recall, ledger, sessionId, cwd: null, config: {} })
  assert.equal(stopped.reason, 'idle-stop')
  closeDb(db)
})

test('humanText：取最后一条真人消息，跳过插件注入的快照', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一句' }] },
    { role: 'user', content: [{ type: 'text', text: '运行时快照' }], source: { kind: 'plugin', plugin: 'x' } },
    { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
  ]
  assert.equal(humanText(messages), '第一句')
  assert.equal(humanText([{ role: 'user', content: '纯字符串' }]), '纯字符串')
  assert.equal(humanText([]), '')
})
