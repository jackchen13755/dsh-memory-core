import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'
import { buildTools, scopeForExec } from '../lib/tools.js'
import { writeMemory } from '../lib/writer.js'
import { compareVersions, SUPPORTED_DSH } from '../lib/host.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-tools-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  store.insertUnit({
    track: 'memory',
    scope: 'global',
    kind: 'rule',
    content: '读取 Figma 设计稿的固定链路：先跑 figma_read_node_ws，再解析 ws.json。',
    meta: { ent: ['figma_read_node_ws'], tags: ['figma'] },
  })
  store.insertUnit({
    track: 'project',
    scope: 'project:abc123',
    kind: 'progress',
    content: '项目日志：底部按钮用 @/components/FooterButton。',
    meta: { ent: ['@/components/FooterButton'] },
  })
  return { db, store, recall: new Recall(store) }
}

test('工具定义符合 dsh 0.1.5-rc.1 的注册契约', () => {
  const { db, store, recall } = fixture()
  const tools = buildTools({ store, recall, host: { version: '0.1.5-rc.1', caps: {} }, config: {} })
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mem_search', 'mem_get', 'mem_diag', 'mem_status', 'mem_write', 'mem_update', 'mem_review', 'mem_extract', 'mem_prompts', 'mem_todo', 'mem_skill'],
  )
  for (const t of tools) {
    assert.equal(typeof t.name, 'string')
    assert.ok(t.description.length > 20, `${t.name} 需要描述`)
    assert.equal(t.parameters.type, 'object', `${t.name} 参数必须是 object 根`)
    assert.equal(t.parameters.additionalProperties, false)
    assert.equal(t.output.schema.type, 'object', `${t.name} 输出 schema 必须是 object 根`)
    assert.equal(typeof t.output.render, 'function', `${t.name} 必须声明 render`)
    assert.equal(typeof t.execute, 'function')
    const rendered = t.output.render({}, { text: 'x' })
    assert.ok(Array.isArray(rendered) && rendered[0].type === 'text', `${t.name} render 应返回 text 分段`)
  }
  closeDb(db)
})

test('mem_write：回报里必须写清落点（track/scope/条目 id），不能只甩个 relation 词', async () => {
  const { db, store, recall } = fixture()
  // 与生产装配一致：写入走 runtime.writer（lib/index.js 里同一个入口）
  const runtime = { writer: { writeMemory: (a) => writeMemory({ store, recall, ...a }) } }
  const tools = buildTools({ store, recall, host: {}, config: {}, runtime })
  const write = tools.find((t) => t.name === 'mem_write')
  const exec = { agent: { session: { id: 's-tools', header: { cwd: '/tmp/tools-proj' } } } }

  const direct = await write.execute({ content: '项目进展：分支列表的悬停高亮做完了。', track: 'project', kind: 'progress' }, exec)
  assert.equal(direct.status, 'written')
  assert.match(direct.text, /^已写入 \[mem:[0-9a-f]{8}\]（track=project · scope=project:[0-9a-f]{12}）/, `实际：${direct.text}`)
  assert.ok(!/unrelated|related/.test(direct.text), '不得把 relation 当成说明文案贴上去')

  const queued = await write.execute({ content: '规则：提交前必须跑 node --test 全量。', track: 'memory', kind: 'rule' }, exec)
  assert.equal(queued.status, 'queued')
  assert.match(queued.text, /^已进待确认队列（建议 [0-9a-f]{8}）（track=memory · scope=global）/, `实际：${queued.text}`)
  assert.match(queued.text, /确认后才会注入上下文/)
  // 归属会话要落到本会话（面板「本会话」才看得到）
  assert.equal(store.db.prepare('SELECT session_id FROM suggestions WHERE id = ?').get(queued.id)?.session_id, 's-tools')
  closeDb(db)
})

test('mem_search：命中 + 渲染文本 + 证据标记', async () => {
  const { db, store, recall } = fixture()
  const [search] = buildTools({ store, recall, host: {}, config: {} })
  const out = await search.execute({ query: 'figma 设计稿怎么读' }, { agent: null })
  assert.ok(out.hits.length >= 1)
  assert.equal(out.hits[0].id.length, 8)
  assert.ok(out.text.includes('[mem:'))
  assert.ok(out.text.includes('mem_get'))
  assert.equal(typeof out.evidence, 'boolean')
  closeDb(db)
})

test('mem_get：取全文并累加访问计数；缺失 id 不抛', async () => {
  const { db, store, recall } = fixture()
  const [, get] = buildTools({ store, recall, host: {}, config: {} })
  const [row] = store.listUnits({ track: 'memory' })
  const out = await get.execute({ id: `${row.id},deadbeef` }, {})
  assert.deepEqual(out.found, [row.id])
  assert.deepEqual(out.missing, ['deadbeef'])
  assert.ok(out.text.includes('figma_read_node_ws'))
  const after = store.getUnit(row.id)
  assert.equal(after.access_count, 1)
  closeDb(db)
})

test('mem_status：报出宿主版本与分轨计数', async () => {
  const { db, store, recall } = fixture()
  const [, , , status] = buildTools({
    store,
    recall,
    host: { version: '0.1.5-rc.1', supported: SUPPORTED_DSH, compatible: true, caps: { tools: true }, latestBackup: null },
    config: {},
  })
  const out = await status.execute({}, {})
  assert.equal(out.counts.units, 2)
  assert.equal(out.host.version, '0.1.5-rc.1')
  assert.ok(out.text.includes('分轨'))
  closeDb(db)
})

test('会话 cwd → 项目作用域（与旧库同一套 sha1(cwd) 标识）', () => {
  assert.equal(scopeForExec({ agent: { session: { header: { cwd: '/tmp/example-workspace' } } } }), 'project:1a264d53adb3')
  assert.equal(scopeForExec({ agent: null }), null)
})

test('版本比较：能判定宿主是否满足声明下限', () => {
  assert.ok(compareVersions('0.1.5-rc.1', '0.1.5-rc.1') === 0)
  assert.ok(compareVersions('0.1.5-rc.2', '0.1.5-rc.1') > 0)
  assert.ok(compareVersions('0.1.5', '0.1.5-rc.1') > 0)
  assert.ok(compareVersions('0.1.4', '0.1.5-rc.1') < 0)
})
