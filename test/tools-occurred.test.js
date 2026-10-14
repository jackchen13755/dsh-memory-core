/**
 * 工具面的事件时间（P0-3 时间维度）：`mem_write` 的 `occurredAt` 参数 + `mem_update` 的改时间能力。
 *
 * 这一层是「模型手动指定事件发生时间」的唯一入口：schema 不声明该字段时，模型传了会被
 * `additionalProperties: false` 直接拒绝 —— 于是「显式指定」形同虚设。本文件锁定三件事：
 *   1. schema 真的声明了该字段（可选、字符串日期或 epoch 数字、显式 null = 未知）；
 *   2. execute 把它映射进 writeMemory，且**沿用 writer 的同一套容错**：非法/空值不传、落 NULL、
 *      绝不因为一个坏时间字段就拒写整条记忆；
 *   3. 直写路径 + 待确认队列路径（采纳时落列）都能读回一致的值。
 *
 * 与其它测试一致：一律在 tmp 副本库上跑，不碰真实库。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { approveSuggestion, normalizeOccurredAt, writeMemory } from '../lib/writer.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-tools-occ-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const recall = new Recall(store)
  // 与生产装配一致：写入走 runtime.writer（lib/index.js 里同一个入口）
  const runtime = {
    writer: {
      writeMemory: (a) => writeMemory({ store, recall, ...a }),
      approveSuggestion: (a) => approveSuggestion({ store, ...a }),
    },
  }
  const tools = buildTools({ store, recall, host: {}, config: {}, runtime })
  return {
    db,
    store,
    write: tools.find((t) => t.name === 'mem_write'),
    update: tools.find((t) => t.name === 'mem_update'),
    exec: { agent: { session: { id: 's-occ', header: { cwd: null } } } },
  }
}

/** 极简 JSON Schema 子集校验（object / additionalProperties:false / required / 属性 type 含联合 / enum）。 */
function typeOk(type, value) {
  const types = Array.isArray(type) ? type : [type]
  return types.some((t) => {
    if (t === 'null') return value === null
    if (t === 'string') return typeof value === 'string'
    if (t === 'number') return typeof value === 'number' && Number.isFinite(value)
    if (t === 'integer') return Number.isInteger(value)
    if (t === 'boolean') return typeof value === 'boolean'
    if (t === 'array') return Array.isArray(value)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  })
}

function schemaError(schema, value) {
  const fmt = (type) => (Array.isArray(type) ? type.join('|') : String(type))
  if (!typeOk(schema.type, value)) return `type mismatch (${fmt(schema.type)}) for ${JSON.stringify(value)}`
  for (const key of schema.required ?? []) {
    if (!(key in value)) return `missing required ${key}`
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in (schema.properties ?? {}))) return `unexpected property ${key}`
    }
  }
  // 逐个已声明属性校验 type（含联合类型）：宿主就是这么用 parameters 校验模型传参的
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!(key in value) || !spec || spec.type === undefined) continue
    if (!typeOk(spec.type, value[key])) return `type mismatch (${fmt(spec.type)}) for property ${key}=${JSON.stringify(value[key])}`
  }
  return null
}

const day = (v) => new Date(v).toISOString().slice(0, 10)
const ISO = '2026-03-04'
const ISO_MS = normalizeOccurredAt(ISO)
const EPOCH = 1772582400000

test('mem_write 的 schema 声明 occurredAt（字符串日期 / epoch 数字 / 显式 null），且仍拒绝未知字段', () => {
  const { db, write } = fixture()
  const props = write.parameters.properties
  assert.ok('occurredAt' in props, 'mem_write 必须声明 occurredAt，否则模型传了会被 additionalProperties:false 拒绝')
  assert.deepEqual(props.occurredAt.type, ['string', 'number', 'null'])
  // 语义写清楚：事件发生时间（不是写入时间）、留空 = 未知、由抽取侧推断
  const desc = props.occurredAt.description
  assert.match(desc, /event time/i)
  assert.match(desc, /epoch-millisecond/)
  assert.match(desc, /unknown/i)
  assert.match(desc, /mem_extract/)
  assert.ok(!write.parameters.required.includes('occurredAt'), 'occurredAt 必须是可选字段')

  const params = write.parameters
  assert.equal(schemaError(params, { content: 'a' }), null)
  assert.equal(schemaError(params, { content: 'a', occurredAt: ISO }), null)
  assert.equal(schemaError(params, { content: 'a', occurredAt: EPOCH }), null)
  assert.equal(schemaError(params, { content: 'a', occurredAt: null }), null)
  // 对照：additionalProperties:false 是真的在生效 —— 正因为如此，上面那几条「接受」才有意义
  assert.match(schemaError(params, { content: 'a', whenItHappened: ISO }), /unexpected property/)
  assert.match(schemaError(params, { content: 'a', occurredAt: true }), /type mismatch/)
  closeDb(db)
})

test('mem_write 合法值：ISO 日期 / 带时区 ISO / epoch 数字 → 落库读回一致，回执点出发生时间', async () => {
  const { db, store, write, exec } = fixture()
  const cases = [
    [ISO, ISO_MS],
    ['2026-03-04T09:30:00+08:00', Date.parse('2026-03-04T01:30:00.000Z')],
    [EPOCH, EPOCH],
    ['1772582400000', EPOCH], // 数字时间戳的字符串形式同样接受（旧调用方习惯）
  ]
  for (const [i, [input, expected]] of cases.entries()) {
    const res = await write.execute({ content: `合法时间样本 ${i}：事件发生在 ${input}`, direct: true, occurredAt: input }, exec)
    assert.equal(res.status, 'written')
    const row = store.getUnit(res.id)
    assert.equal(row.occurred_at, expected, `${input} 落库值应与 writer 的归一化一致`)
    assert.match(res.text, new RegExp(`发生时间 ${day(expected)}`))
  }
  closeDb(db)
})

test('mem_write 容错与 writer 同一套：非法/空/错类型 → 记忆照样写入、occurred_at 为 NULL、回执不谎报', async () => {
  const { db, store, write, exec } = fixture()
  const invalid = ['not-a-date', '第二章', '2026-13-45', '', '   ', true, false, {}, [], NaN, Infinity, -5]
  for (const [i, bad] of invalid.entries()) {
    const res = await write.execute({ content: `非法时间样本 ${i}：值=${String(bad)}`, direct: true, occurredAt: bad }, exec)
    assert.equal(res.status, 'written', `occurredAt=${String(bad)} 不得导致拒写`)
    const row = store.getUnit(res.id)
    assert.equal(row.occurred_at, null, `occurredAt=${String(bad)} 应落 NULL`)
    assert.equal(normalizeOccurredAt(bad), null, '该值在 writer 侧也必须判为「未知」')
    assert.ok(!res.text.includes('发生时间'), '没有有效发生时间时，回执不能谎报')
  }
  closeDb(db)
})

test('mem_write 不传 occurredAt → NULL，且回报格式与改造前一致', async () => {
  const { db, store, write, exec } = fixture()
  const res = await write.execute({ content: '不传事件时间的记忆：正文照旧', direct: true }, exec)
  assert.equal(res.status, 'written')
  assert.equal(store.getUnit(res.id).occurred_at, null)
  assert.ok(!res.text.includes('发生时间'))
  assert.match(res.text, /^已写入 \[mem:.+?\]（track=memory · scope=global）$/)
  closeDb(db)
})

test('待确认队列路径：mem_write 的 occurredAt 随 payload 进队列，采纳（approveSuggestion）后落列', async () => {
  const { db, store, write, exec } = fixture()
  // memory 轨 + fact → 按分轨规则进待确认队列（零直写铁律）
  const res = await write.execute({ content: '队列路径：事件发生在 2026-04-05 的那次设计评审', occurredAt: '2026-04-05' }, exec)
  assert.equal(res.status, 'queued')
  const suggestion = store.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(res.id)
  const payload = JSON.parse(suggestion.payload)
  assert.equal(payload.occurredAt, normalizeOccurredAt('2026-04-05'), '进队列这一步不能把事件时间丢掉')

  const approved = approveSuggestion({ store, id: res.id })
  assert.equal(approved.ok, true)
  assert.equal(store.getUnit(approved.id).occurred_at, normalizeOccurredAt('2026-04-05'), '采纳落库这一跳最容易漏')
  assert.equal(approved.occurredAt, normalizeOccurredAt('2026-04-05'))
  closeDb(db)
})

test('mem_update：显式改事件时间 / 显式清空 / 不传保持原值', async () => {
  const { db, store, write, update, exec } = fixture()
  const created = await write.execute({ content: '待改时间的记忆：某次架构评审', direct: true, occurredAt: '2026-05-06' }, exec)
  const id = created.id
  assert.equal(store.getUnit(id).occurred_at, normalizeOccurredAt('2026-05-06'))

  // ① 改成另一个时间
  const moved = await update.execute({ id, content: '改过正文的记忆：某次架构评审', occurredAt: '2026-07-08' }, exec)
  assert.equal(moved.ok, true)
  assert.match(moved.text, new RegExp(`发生时间 ${day(normalizeOccurredAt('2026-07-08'))}`))
  assert.equal(store.getUnit(id).occurred_at, normalizeOccurredAt('2026-07-08'))

  // ② 不传 → 保持原值（不能被顺手清掉）
  const untouched = await update.execute({ id, content: '再改一次正文' }, exec)
  assert.equal(untouched.ok, true)
  assert.equal(store.getUnit(id).occurred_at, normalizeOccurredAt('2026-07-08'))
  assert.ok(!untouched.text.includes('发生时间'))

  // ③ 显式 null → 清空为未知
  const cleared = await update.execute({ id, occurredAt: null }, exec)
  assert.equal(cleared.ok, true)
  assert.match(cleared.text, /发生时间已清空/)
  assert.equal(store.getUnit(id).occurred_at, null)
  closeDb(db)
})

test('mem_update：非法值不使编辑失败、时间保持原值，并在回执里说明未改动', async () => {
  const { db, store, write, update, exec } = fixture()
  const created = await write.execute({ content: '时间非法值测试的记忆：导入脚本改造', direct: true, occurredAt: '2026-06-07' }, exec)
  const before = store.getUnit(created.id).occurred_at
  const res = await update.execute({ id: created.id, content: '时间非法值测试的记忆：导入脚本改造（v2）', occurredAt: '不是日期' }, exec)
  assert.equal(res.ok, true, '坏时间字段不得让整次编辑失败')
  assert.match(res.text, /发生时间未改动/)
  assert.equal(store.getUnit(created.id).occurred_at, before)
  assert.equal(store.getUnit(created.id).content.includes('（v2）'), true)
  closeDb(db)
})

test('mem_update action=archive 不静默吞掉 occurredAt：回执说明要在 edit 时传', async () => {
  const { db, store, write, update, exec } = fixture()
  const created = await write.execute({ content: '归档路径的时间字段提示', direct: true, occurredAt: '2026-08-09' }, exec)
  const res = await update.execute({ id: created.id, action: 'archive', occurredAt: '2026-09-10' }, exec)
  assert.equal(res.ok, true)
  assert.match(res.text, /发生时间未改动/)
  assert.equal(store.getUnit(created.id).occurred_at, normalizeOccurredAt('2026-08-09'), '归档不动事件时间')
  closeDb(db)
})

test('mem_update 的 schema 也声明 occurredAt（工具面对称，可选）', () => {
  const { db, update } = fixture()
  assert.ok('occurredAt' in update.parameters.properties)
  assert.deepEqual(update.parameters.properties.occurredAt.type, ['string', 'number', 'null'])
  assert.ok(!update.parameters.required.includes('occurredAt'))
  assert.equal(schemaError(update.parameters, { id: 'x', occurredAt: '2026-01-02' }), null)
  closeDb(db)
})
