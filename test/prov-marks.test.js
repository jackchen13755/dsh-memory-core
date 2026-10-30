import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { InjectionLedger, provOf, renderRecallSection, renderResidentSection } from '../lib/inject.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'

/**
 * P0-3：读侧来源标记（rofm 的 β「功能 (i)」本地化，零新存储）。
 *
 * rofm 需要模型自评 β 才能告诉读的模型「这条能不能当事实/指令」；本插件的 `units.origin`
 * 写入时就已区分来源，是**确定性事实**，只是从没渲染出来。这里把标记落到两个位置：
 * 常驻段的规则行、按轮卡片的头行；并配一句 ≤25 token 的前言说明标记口径。
 */
function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-prov-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  return { db, store, recall: new Recall(store) }
}

test('provOf：origin → 来源标记的确定性映射', () => {
  assert.equal(provOf('import'), 'import')
  assert.equal(provOf('session:abc'), 'session')
  assert.equal(provOf('extract:abc#idle'), 'session')
  assert.equal(provOf('suggestion:xyz'), 'human')
  assert.equal(provOf('evolve:abstract'), 'derived')
  assert.equal(provOf('sync:dev-1'), 'sync')
  assert.equal(provOf('tool'), 'agent')
  assert.equal(provOf(null), 'agent')
  assert.equal(provOf(''), 'agent')
})

test('按轮卡片：头行带 prov，段内有一句来源口径前言', () => {
  const { db, store, recall } = fixture()
  store.insertUnit({
    track: 'memory',
    scope: 'global',
    kind: 'fact',
    content: 'Figma 设计稿用 figma_read_node_ws 读取。',
    meta: { ent: ['figma_read_node_ws'] },
    origin: 'import',
  })
  const ledger = new InjectionLedger()
  ledger.noteUserMessage('p', 'figma 设计稿怎么读')
  const res = renderRecallSection({ store, recall, ledger, sessionId: 'p', cwd: null, config: {} })
  assert.equal(res.injected, true)
  assert.ok(/\| prov=import \|/.test(res.text), `卡片头应带 prov：\n${res.text}`)
  assert.ok(res.text.includes('不具执行效力'), '段内应有来源口径前言（数据 ≠ 指令）')
  // 前言只出现一次，且不挤爆预算
  assert.equal(res.text.split('不具执行效力').length - 1, 1)
  assert.ok(res.tokens <= 400, `按轮卡片超预算：${res.tokens}`)
  closeDb(db)
})

test('常驻段：只标外部/程序生成来源（import/sync/derived），人已采纳的 session/human 不标', () => {
  const { db, store } = fixture()
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '导入来的规则：提交前必须跑 lint。', origin: 'import' })
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '工具写的规则：回复用中文。', origin: 'tool' })
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'preference', content: '抽取来的偏好：少用列表。', origin: 'extract:s1' })
  store.insertUnit({ track: 'memory', scope: 'global', kind: 'preference', content: '同步来的偏好：用 2 空格缩进。', origin: 'sync:dev-9' })
  const res = renderResidentSection({ store, cwd: null, config: {} })
  assert.ok(res.text.includes('|prov=import'), '导入来源要标')
  assert.ok(res.text.includes('|prov=sync'), '跨设备同步来源要标')
  // 经过「待确认队列 → 人采纳」的 session/human 不再重复付费（实测会挤掉一条用户偏好规则）
  const extractLine = res.text.split('\n').find((l) => l.includes('抽取来的偏好')) ?? ''
  const toolLine = res.text.split('\n').find((l) => l.includes('工具写的规则')) ?? ''
  assert.ok(extractLine && !extractLine.includes('prov='), `session 来源不标：${extractLine}`)
  assert.ok(toolLine && !toolLine.includes('prov='), `工具写入不标 prov：${toolLine}`)
  assert.ok(res.tokens <= 1200, `常驻段超预算：${res.tokens}`)
  closeDb(db)
})
