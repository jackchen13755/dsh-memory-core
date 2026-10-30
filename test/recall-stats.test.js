import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { InjectionLedger } from '../lib/inject.js'

/**
 * P0-5：召回质量可观测性（rofm⑧⑨ 的本地化，零新工具）。
 *
 * `recall_log` 一直是只写不读的事实源：没有聚合出口，「注入率 / 哪条被反复召回 /
 * 哪些条目重要度已经过高 / 有没有被隔离的导入条目」都答不了。
 * 现在 `mem_status` 直接回答它们（不新增表、不新增工具、不改工具名）。
 * 另对齐 rofm 的 α 告警：`importance ≥ warnAbove` **只告警不拦截**。
 */
function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-stats-')), 'mem.db'))
  migrate(db)
  return { db, store: new Store(db), recall: null }
}

function logRow(store, { unitId = null, query = 'q', injected = 1, ts = Date.now() } = {}) {
  store.db
    .prepare('INSERT INTO recall_log (ts, session_id, query, unit_id, channel, rank, score, injected, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ts, 's1', query, unitId, 'lexical+sparse', 1, 0.5, injected, null)
}

test('mem_status：注入率分子分母正确，且列出高频召回条目', async () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  const tool = buildTools({ store, recall, host: {}, config: {} }).find((t) => t.name === 'mem_status')
  const { id } = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: 'Figma 设计稿用 figma_read_node_ws 读取。', origin: 'tool' })
  // 3 次检索、2 次注入
  logRow(store, { unitId: id, query: 'a', injected: 1 })
  logRow(store, { unitId: id, query: 'b', injected: 1 })
  logRow(store, { unitId: id, query: 'c', injected: 0 })
  const out = await tool.execute({})
  assert.equal(out.recallStats.retrievals, 3)
  assert.equal(out.recallStats.injected, 2)
  assert.equal(out.recallStats.injectionRate, 0.667)
  assert.ok(out.text.includes('（67%）'), `应报显式检索的强证据命中率：\n${out.text}`)
  assert.ok(out.text.includes('显式检索 3 次'), '口径必须写明是「显式检索」，不能假装是自动召回')
  assert.ok(out.text.includes(`mem:${id}×2`), '高频召回要列出命中次数')
  assert.equal(out.recallStats.topRecalled[0].prov, 'agent')
  closeDb(db)
})

test('mem_status：自动召回单独报（它走 log:false，不进 recall_log）', async () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  const ledger = new InjectionLedger()
  ledger.noteUserMessage('s-auto', 'q')
  ledger.noteRecall('s-auto', { tokens: 120, cards: 2, injected: true })
  const tool = buildTools({ store, recall, host: {}, config: {}, ledger }).find((t) => t.name === 'mem_status')
  const out = await tool.execute({})
  assert.equal(out.recallStats.auto.sections, 1)
  assert.equal(out.recallStats.auto.cards, 2)
  assert.equal(out.recallStats.auto.tokens, 120)
  assert.ok(out.text.includes('自动召回（本进程）：1 次注入 / 2 张卡片 / 120 token'), out.text)
  closeDb(db)
})

test('mem_status：importance ≥ warnAbove 的条目进告警清单（只告警，不改值）', async () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  const hot = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '过高重要度条目。', importance: 0.95 })
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: '普通条目。', importance: 0.5 })
  const tool = buildTools({ store, recall, host: {}, config: {} }).find((t) => t.name === 'mem_status')
  const out = await tool.execute({})
  assert.equal(out.recallStats.warnAbove, 0.8)
  assert.equal(out.recallStats.highImportance.length, 1)
  assert.equal(out.recallStats.highImportance[0].id, hot.id)
  assert.ok(out.text.includes('高重要度'), out.text)
  // 只告警不拦截：库里值必须原样
  const after = store.getUnit(hot.id)
  assert.equal(Number(after.importance), 0.95)
  closeDb(db)
})

test('mem_status：隔离计数 + 空库不抛错', async () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  const tool = buildTools({ store, recall, host: {}, config: {} }).find((t) => t.name === 'mem_status')
  const empty = await tool.execute({})
  assert.equal(empty.recallStats.retrievals, 0)
  assert.equal(empty.recallStats.injectionRate, 0)
  assert.equal(empty.quarantine.quarantined, 0)
  assert.ok(empty.text.length > 0)

  store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '被隔离的条目。', meta: { quarantined: true } })
  const out = await tool.execute({})
  assert.equal(out.quarantine.quarantined, 1)
  assert.ok(out.text.includes('已隔离：1 条'), out.text)
  closeDb(db)
})

test('mem_status：窗口外（超过 statsDays）的检索不计入', async () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  const tool = buildTools({ store, recall, host: {}, config: { recall: { statsDays: 1 } } }).find((t) => t.name === 'mem_status')
  logRow(store, { ts: Date.now() - 10 * 86400000 })
  const out = await tool.execute({})
  assert.equal(out.recallStats.retrievals, 0, '10 天前的检索不应计入近 1 天窗口')
  closeDb(db)
})

test('mem_status 会先刷新能力探测（修「tools=✗ 但工具在跑」的误报）', async () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  // 模拟"启动时探测落空、真正跑起来后服务已就绪"的场景
  const host = {
    version: '0.2.1-rc.5',
    supported: '>=0.1.5-rc.1',
    compatible: true,
    caps: { tools: false, systemPrompt: true, commands: false, llm: true, webserver: false, sessionEvents: true },
    refresh() {
      this.caps = { ...this.caps, tools: true, commands: true, webserver: true }
      return this
    },
  }
  const tool = buildTools({ store, recall, host, config: {} }).find((t) => t.name === 'mem_status')
  const out = await tool.execute({})
  assert.equal(out.host.caps.tools, true, '刷新后应报告 tools 可用')
  assert.ok(out.text.includes('tools=✓'), `文本必须反映刷新后的能力：\n${out.text}`)
  assert.ok(out.text.includes('commands=✓'))
  closeDb(db)
})

test('mem_status 没有 refresh 时（老宿主/测试桩）不得报错', async () => {
  const { db, store } = fixture()
  const recall = new Recall(store)
  const tool = buildTools({ store, recall, host: { version: '0.1.5', caps: { tools: true } }, config: {} }).find((t) => t.name === 'mem_status')
  const out = await tool.execute({})
  assert.ok(out.text.length > 0)
  closeDb(db)
})
