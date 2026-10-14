/**
 * t7：occurred_at 的写入侧消费（往返测试）。
 *
 * 覆盖三条落库路径 + 一条最容易漏的队列路径：
 *   1. writeMemory 直写（project/progress 免确认、force=true 直写）→ units.occurred_at
 *   2. 分轨规则进待确认队列 → approveSuggestion 采纳 → units.occurred_at（payload 必须带着时间）
 *   3. 会话提取链路：extractSession → item.occurredAt → extractItemToInput → writeMemory(queueOnly) → 采纳
 * 另覆盖字段容错：缺失 / null / 非法值一律写 NULL，**绝不因该字段拒写整条记忆**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { extractSession } from '../lib/extract.js'
import { extractItemToInput } from '../lib/index.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'
import { approveSuggestion, normalizeOccurredAt, writeMemory } from '../lib/writer.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-t7-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const recall = new Recall(store)
  return { db, store, recall, cwd: '/tmp/example-workspace' }
}

/** 读回某条 unit 的事件时间（走 Store API，证明"写进去能读回"）。 */
const occurredOf = (store, id) => store.getUnit(id)?.occurred_at ?? null

const suggestionPayload = (store, id) =>
  JSON.parse(store.db.prepare('SELECT payload FROM suggestions WHERE id = ?').get(id).payload)

test('writeMemory：occurredAt 接受 epoch 数值 / ISO 串 / YYYY-MM-DD / Date 实例 / 数值串，一致落进 units.occurred_at', () => {
  const { db, store, recall, cwd } = fixture()
  const epoch = Date.UTC(2026, 2, 5, 8, 30) // 2026-03-05T08:30:00Z
  const cases = [
    ['epoch 数值', epoch, epoch],
    ['ISO 串', '2026-03-05T08:30:00.000Z', epoch],
    ['YYYY-MM-DD', '2026-03-05', Date.parse('2026-03-05')],
    ['Date 实例', new Date(epoch), epoch],
    ['数值字符串', String(epoch), epoch],
  ]
  for (const [label, input, expect] of cases) {
    const res = writeMemory({
      store,
      recall,
      cwd,
      input: { content: `事件时间样本（${label}）：这一步把写入路径接通了。`, track: 'project', kind: 'progress', occurredAt: input },
    })
    assert.equal(res.status, 'written', label)
    assert.equal(occurredOf(store, res.id), expect, label)
  }
  assert.equal(store.counts().units, cases.length)
  closeDb(db)
})

test('writeMemory：occurredAt 缺失 / null / 空 / 非法 → 写 NULL，且绝不因该字段拒写整条记忆', () => {
  const { db, store, recall, cwd } = fixture()
  const cases = [
    ['缺失', undefined],
    ['null', null],
    ['空串', ''],
    ['空白串', '   '],
    ['非日期串', '上个星期二'],
    ['越界日期', '2026-13-45'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['负数', -1],
    ['布尔', true],
    ['对象', {}],
    ['数组', []],
  ]
  for (const [label, input] of cases) {
    const res = writeMemory({
      store,
      recall,
      cwd,
      input: { content: `容错样本（${label}）：坏时间字段不能连累整条记忆。`, track: 'project', kind: 'progress', occurredAt: input },
    })
    assert.equal(res.status, 'written', `${label} 必须照常写入`)
    assert.equal(occurredOf(store, res.id), null, `${label} 应保持 NULL`)
  }
  assert.equal(store.counts().units, cases.length)
  closeDb(db)
})

test('normalizeOccurredAt：归一到 epoch ms；坏值一律 null 且从不抛错', () => {
  assert.equal(normalizeOccurredAt('2026-03-05'), Date.parse('2026-03-05'))
  assert.equal(normalizeOccurredAt('2026-03-05T08:30:00Z'), Date.parse('2026-03-05T08:30:00Z'))
  assert.equal(normalizeOccurredAt(1770000000000), 1770000000000)
  assert.equal(normalizeOccurredAt('1770000000000'), 1770000000000)
  assert.equal(normalizeOccurredAt(new Date(1770000000000)), 1770000000000)
  assert.equal(normalizeOccurredAt(1770000000000.7), 1770000000000, '小数截断')
  assert.equal(normalizeOccurredAt('  2026-03-05  '), Date.parse('2026-03-05'), '前后空白容忍')
  for (const bad of [null, undefined, '', '   ', '不是日期', '2026-13-45', Number.NaN, Number.POSITIVE_INFINITY, -1, 9e15, {}, [], true]) {
    assert.equal(normalizeOccurredAt(bad), null, `坏值应归 null：${String(bad)}`)
  }
})

test('待确认队列路径：occurredAt 随 payload 进队列，采纳落库时带回 units（这一跳最容易漏）', () => {
  const { db, store, recall, cwd } = fixture()
  const ms = Date.parse('2026-04-01T10:00:00Z')
  const queued = writeMemory({
    store,
    recall,
    cwd,
    input: { content: '约定：所有检索必须带项目作用域。', track: 'memory', kind: 'rule', occurredAt: ms },
  })
  assert.equal(queued.status, 'queued', '规则轨需人工确认')
  assert.equal(store.counts().units, 0, '待确认期间不落 units')
  assert.equal(suggestionPayload(store, queued.id).occurredAt, ms, 'payload 必须带着事件时间进队列')

  const approved = approveSuggestion({ store, id: queued.id })
  assert.equal(approved.ok, true)
  assert.equal(approved.occurredAt, ms)
  assert.equal(occurredOf(store, approved.id), ms, '采纳时必须写回 units.occurred_at')
  closeDb(db)
})

test('采纳时 overrides.occurredAt 覆盖 payload；payload 没带时间则保持 NULL', () => {
  const { db, store, recall, cwd } = fixture()
  const fromPayload = Date.parse('2026-04-02T00:00:00Z')
  const override = Date.parse('2026-04-03T00:00:00Z')
  const withTime = writeMemory({
    store,
    recall,
    cwd,
    input: { content: '偏好：待办一律当天闭环。', track: 'memory', kind: 'preference', occurredAt: fromPayload },
  })
  const r1 = approveSuggestion({ store, id: withTime.id, overrides: { occurredAt: override } })
  assert.equal(occurredOf(store, r1.id), override, '采纳时的显式指定优先')

  const noTime = writeMemory({
    store,
    recall,
    cwd,
    input: { content: '偏好：写入时默认不指定事件时间。', track: 'memory', kind: 'preference' },
  })
  assert.equal(suggestionPayload(store, noTime.id).occurredAt, undefined, '没给时间就不往 payload 里塞')
  const r2 = approveSuggestion({ store, id: noTime.id })
  assert.equal(occurredOf(store, r2.id), null)
  closeDb(db)
})

test('force 直写路径同样落 occurred_at', () => {
  const { db, store, recall, cwd } = fixture()
  const ms = Date.parse('2026-04-04T12:00:00Z')
  const res = writeMemory({
    store,
    recall,
    cwd,
    force: true,
    input: { content: '决策：写入侧只认显式给出的 occurredAt。', track: 'memory', kind: 'decision', occurredAt: ms },
  })
  assert.equal(res.status, 'written')
  assert.equal(occurredOf(store, res.id), ms)
  closeDb(db)
})

test('提取链路：item.occurredAt → extractItemToInput → writeMemory(queueOnly) → 采纳落库', async () => {
  const { db, store, recall, cwd } = fixture()
  const seen = []
  const day = '2026-04-05'
  const llm = {
    stream: () =>
      (async function* () {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: [
              {
                content: '会话里定下的约定：所有检索必须带项目作用域。',
                track: 'key',
                kind: 'decision',
                confidence: 0.9,
                evidence: '用户拍板',
                occurredAt: day,
              },
            ],
          }),
        }
      })(),
  }
  const res = await extractSession({
    store,
    transcript: '用户: 我们定一下约定\n助手: 好的',
    llm,
    route: { provider: 'p', model: 'm' },
    sessionId: 's-occurred',
    enqueue: (item) => {
      seen.push(item)
      return writeMemory({
        store,
        recall,
        cwd,
        input: extractItemToInput(item, { sessionId: 's-occurred', reason: 'idle' }),
        origin: 'extract:s-occurred',
        sessionId: 's-occurred',
        queueOnly: true,
      })
    },
  })
  assert.equal(res.ok, true)
  assert.equal(seen[0].occurredAt, Date.parse(day), '抽取侧已把日期解析成 epoch ms')
  assert.equal(store.counts().units, 0, '零直写：提取产物一律先入队列')

  const pending = store.listSuggestions({ status: 'pending' })
  assert.equal(pending.length, 1)
  const payload = suggestionPayload(store, pending[0].id)
  assert.equal(payload.occurredAt, Date.parse(day), '队列 payload 带着事件时间')
  assert.equal(payload.meta.source, 'extract:s-occurred#idle', '字段映射仍走同一条 source 规则')

  const approved = approveSuggestion({ store, id: pending[0].id })
  assert.equal(occurredOf(store, approved.id), Date.parse(day), '整条链路：发生时间最终落到 units.occurred_at')
  closeDb(db)
})

test('提取产物 occurredAt 非法：只丢时间字段，整条仍照常入队（回落 NULL）', async () => {
  const { db, store, recall, cwd } = fixture()
  const seen = []
  const llm = {
    stream: () =>
      (async function* () {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: [
              { content: '今天把提取链路的时间字段接线做完了。', track: 'daily', kind: 'progress', confidence: 0.8, evidence: '助手总结', occurredAt: '不是日期' },
            ],
          }),
        }
      })(),
  }
  const res = await extractSession({
    store,
    transcript: '用户: 今天做了什么\n助手: 接了时间字段',
    llm,
    route: { provider: 'p', model: 'm' },
    sessionId: 's-bad-date',
    enqueue: (item) => {
      seen.push(item)
      return writeMemory({
        store,
        recall,
        cwd,
        input: extractItemToInput(item, { sessionId: 's-bad-date', reason: 'idle' }),
        origin: 'extract:s-bad-date',
        queueOnly: true,
      })
    },
  })
  assert.equal(res.ok, true)
  assert.equal(seen[0].occurredAt, null, '坏日期归 null，不抛错')
  const pending = store.listSuggestions({ status: 'pending' })
  assert.equal(pending.length, 1, '整条记忆必须还在（不能因一个坏字段被丢弃）')
  const approved = approveSuggestion({ store, id: pending[0].id })
  assert.equal(occurredOf(store, approved.id), null)
  closeDb(db)
})
