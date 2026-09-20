import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installApi } from '../lib/api.js'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { PromptManager } from '../lib/prompts.js'
import { SkillManager } from '../lib/skills.js'
import { Store } from '../lib/store.js'
import { TodoManager } from '../lib/todos.js'
import { approveSuggestion, archiveSuggestion, rejectSuggestion, restoreSuggestion, sweepSuggestions, writeMemory } from '../lib/writer.js'
import { Recall } from '../lib/recall.js'

/** 假 webServer：捕获注册的路由，返回可控的 req/res。 */
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'memcore-api-'))
  const db = openDb(join(root, 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const recall = new Recall(store)
  const prompts = new PromptManager(store)
  const ledger = { snapshot: () => ({ totals: { residentTokens: 10, recallTokens: 5, cards: 1, turns: 3, hitTurns: 2 } }) }
  const todos = new TodoManager(store)
  // 技能目录指向临时目录：面板写操作会真的改 SKILL.md，测试绝不能碰 ~/.agents/skills
  const skills = new SkillManager(store, { dir: join(root, 'skills') })
  const runtime = {
    writer: {
      writeMemory: (a) => writeMemory({ store, recall, ...a }),
      approveSuggestion: (a) => approveSuggestion({ store, ...a }),
      rejectSuggestion: (a) => rejectSuggestion({ store, ...a }),
      archiveSuggestion: (a) => archiveSuggestion({ store, ...a }),
      restoreSuggestion: (a) => restoreSuggestion({ store, ...a }),
    },
    extractNow: async () => ({ ok: true, queued: 2 }),
    steer: () => true,
    todos,
    skills,
  }
  const routes = []
  const ctx = {
    inject: (_deps, cb) => {
      cb({ webServer: { register: (route) => (routes.push(route), () => {}) } })
    },
  }
  installApi(ctx, { store, recall, prompts, ledger, runtime, host: { version: '0.1.5-rc.1', supported: '>=0.1.5-rc.1', compatible: true, caps: {} }, config: {} })
  assert.equal(routes.length, 1, '应注册一条前缀路由')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/memory-core/api')

  const call = async (method, url, body = null) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c
      },
    }
    let status = 0
    let payload = ''
    const res = {
      writeHead(code) {
        status = code
      },
      end(text) {
        payload = text
      },
    }
    await routes[0].handler(req, res)
    return { status, json: payload ? JSON.parse(payload) : null }
  }
  return { db, store, recall, prompts, call, todos, skills }
}

test('GET /status：宿主信息 + 计数 + 注入账本', async () => {
  const h = harness()
  h.store.insertUnit({ track: 'memory', scope: 'global', content: '一条记忆。' })
  const { status, json } = await h.call('GET', '/memory-core/api/status')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.host.version, '0.1.5-rc.1')
  assert.equal(json.counts.units, 1)
  assert.equal(json.injection.totals.residentTokens, 10)
  assert.ok('extraction' in json && 'evolution' in json)
  closeDb(h.db)
})

test('GET /badge：待确认与活跃注入计数', async () => {
  const h = harness()
  writeMemory({ store: h.store, recall: h.recall, cwd: null, input: { content: '待确认的规则条目。', track: 'memory', kind: 'rule' } })
  const created = h.prompts.createPrompt({ name: 'P', body: 'B' })
  h.prompts.createInjection({ promptId: created.id, title: 'P', content: 'B', rounds: 0, every: 1 })
  const { json } = await h.call('GET', '/memory-core/api/badge')
  assert.equal(json.suggestions, 1)
  assert.equal(json.prompts, 1)
  closeDb(h.db)
})

test('待确认队列：列表 / 采纳（可改轨）/ 拒绝 / 归档', async () => {
  const h = harness()
  const queued = writeMemory({ store: h.store, recall: h.recall, cwd: null, input: { content: '推理等级要显式声明。', track: 'memory', kind: 'rule' } })
  const list = await h.call('GET', '/memory-core/api/suggestions?status=pending')
  assert.equal(list.json.entries.length, 1)
  assert.equal(list.json.entries[0].id, queued.id)

  const approved = await h.call('POST', '/memory-core/api/suggestions/approve', { id: queued.id, overrides: { track: 'key' } })
  assert.equal(approved.json.ok, true)
  assert.equal(h.store.counts().units, 1)
  assert.equal(h.store.listUnits({ track: 'key' }).length, 1, '改轨后落在 key 轨')

  const q2 = writeMemory({ store: h.store, recall: h.recall, cwd: null, input: { content: '第二条待确认。', track: 'memory', kind: 'rule' } })
  const rejected = await h.call('POST', '/memory-core/api/suggestions/reject', { ids: [q2.id], reason: '太笼统' })
  assert.equal(rejected.json.results[0].ok, true)
  assert.equal(h.store.listSuggestions({ status: 'rejected' }).length, 1)

  const q3 = writeMemory({ store: h.store, recall: h.recall, cwd: null, input: { content: '第三条待确认。', track: 'memory', kind: 'rule' } })
  await h.call('POST', '/memory-core/api/suggestions/archive', { id: q3.id })
  assert.equal(h.store.listSuggestions({ status: 'archived' }).length, 1)

  // 归档必须能在面板「已归档」视图里查回来（否则归档=丢件）；恢复后回到待确认队列
  const arch = await h.call('GET', '/memory-core/api/suggestions?status=archived&sessionId=all')
  assert.deepEqual(arch.json.entries.map((e) => e.id), [q3.id])
  assert.equal(arch.json.entries[0].status, 'archived')
  const restored = await h.call('POST', '/memory-core/api/suggestions/restore', { id: q3.id })
  assert.equal(restored.json.results[0].ok, true)
  assert.equal(h.store.listSuggestions({ status: 'archived' }).length, 0)
  assert.deepEqual(h.store.listSuggestions({ status: 'pending' }).map((r) => r.id), [q3.id])

  // 已归档的会话归属照旧，能被「本会话」过滤命中
  const owned = writeMemory({ store: h.store, recall: h.recall, cwd: null, input: { content: '第四条待确认（归属会话）。', track: 'memory', kind: 'rule' }, origin: 'session:s-api-1' })
  await h.call('POST', '/memory-core/api/suggestions/archive', { id: owned.id })
  const mine = await h.call('GET', '/memory-core/api/suggestions?status=pending&sessionId=s-api-1')
  assert.equal(mine.json.entries.length, 0, '归档后不在本会话待确认里')
  const orphanish = await h.call('GET', '/memory-core/api/suggestions?status=pending&sessionId=other')
  assert.equal(orphanish.json.entries.length, 0)
  closeDb(h.db)
})

test('POST /extract：缺 sessionId 时明确报错；有则返回抽取结果', async () => {
  const h = harness()
  const bad = await h.call('POST', '/memory-core/api/extract', {})
  assert.equal(bad.json.ok, false)
  const good = await h.call('POST', '/memory-core/api/extract', { sessionId: 's-1' })
  assert.equal(good.json.ok, true)
  assert.equal(good.json.queued, 2)
  closeDb(h.db)
})

test('提示词：列表 / 注入 / 活跃 / 停止', async () => {
  const h = harness()
  const p = h.prompts.createPrompt({ name: '代码评审', summary: '评审用', body: '正文' })
  const list = await h.call('GET', '/memory-core/api/prompts?enabled=1')
  assert.equal(list.json.entries.length, 1)

  const inj = await h.call('POST', '/memory-core/api/prompts/inject', { id: p.id, rounds: 0, every: 1, sessionId: 's-1', immediate: true })
  assert.equal(inj.json.ok, true)
  assert.equal(inj.json.nudged, true, '有 sessionId 且 immediate 时应插话')

  const active = await h.call('GET', '/memory-core/api/prompts/active?sessionId=s-1')
  assert.equal(active.json.entries.length, 1)

  const stop = await h.call('POST', '/memory-core/api/prompts/stop', { id: p.id })
  assert.equal(stop.json.stopped, 1)
  const after = await h.call('GET', '/memory-core/api/prompts/active?sessionId=s-1')
  assert.equal(after.json.entries.length, 0)
  closeDb(h.db)
})

test('记忆：列表 / 详情 / 编辑 / 归档恢复 / 404', async () => {
  const h = harness()
  const unit = h.store.insertUnit({ track: 'memory', scope: 'global', content: '旧文案' })
  const list = await h.call('GET', '/memory-core/api/memory?track=memory')
  assert.equal(list.json.entries.length, 1)

  const detail = await h.call('GET', `/memory-core/api/memory/get?id=${unit.id}`)
  assert.equal(detail.json.unit.content, '旧文案')

  const updated = await h.call('POST', '/memory-core/api/memory/update', { id: unit.id, content: '新文案' })
  assert.equal(updated.json.ok, true)
  assert.equal(h.store.getUnit(unit.id).content, '新文案')

  await h.call('POST', '/memory-core/api/memory/update', { id: unit.id, action: 'archive' })
  assert.equal(h.store.getUnit(unit.id).status, 'archived')
  await h.call('POST', '/memory-core/api/memory/update', { id: unit.id, action: 'restore' })
  assert.equal(h.store.getUnit(unit.id).status, 'active')

  const missing = await h.call('GET', '/memory-core/api/memory/get?id=nope')
  assert.equal(missing.status, 404)
  const unknown = await h.call('GET', '/memory-core/api/nope')
  assert.equal(unknown.status, 404)
  closeDb(h.db)
})

test('待办写操作：进行中 / 完成 / 删除（面板 3 个按钮的路由回归）', async () => {
  const h = harness()
  const added = h.todos.add({ content: '面板写操作回归', track: 'work' })
  assert.equal(added.ok, true)
  const statusOf = () => h.store.db.prepare('SELECT status FROM todos WHERE id = ?').get(added.id)?.status

  const doing = await h.call('POST', '/memory-core/api/todos/update', { id: added.id, status: 'doing' })
  assert.equal(doing.status, 200)
  assert.equal(doing.json.ok, true)
  assert.equal(statusOf(), 'doing')

  const done = await h.call('POST', '/memory-core/api/todos/update', { id: added.id, action: 'done' })
  assert.equal(done.status, 200)
  assert.equal(done.json.ok, true)
  assert.equal(statusOf(), 'done')

  const removed = await h.call('POST', '/memory-core/api/todos/update', { id: added.id, action: 'remove' })
  assert.equal(removed.status, 200)
  assert.equal(removed.json.ok, true)
  assert.equal(h.store.db.prepare('SELECT 1 AS x FROM todos WHERE id = ?').get(added.id), undefined)

  const missing = await h.call('POST', '/memory-core/api/todos/update', { id: 'nope', action: 'remove' })
  assert.equal(missing.json.ok, false)
  closeDb(h.db)
})

test('技能写操作：禁用 / 启用（面板 2 个按钮的路由回归，只写临时技能目录）', async () => {
  const h = harness()
  const file = join(h.skills.dir, 'demo-skill', 'SKILL.md')
  mkdirSync(join(h.skills.dir, 'demo-skill'), { recursive: true })
  writeFileSync(file, '---\nname: demo-skill\ndescription: 回归用\n---\n\n正文若干。\n', 'utf8')
  h.skills.scan()
  const enabledOf = () => h.store.db.prepare('SELECT enabled FROM skills WHERE name = ?').get('demo-skill')?.enabled

  const off = await h.call('POST', '/memory-core/api/skills/update', { name: 'demo-skill', action: 'disable' })
  assert.equal(off.status, 200)
  assert.equal(off.json.ok, true)
  assert.match(readFileSync(file, 'utf8'), /disable-model-invocation: true/)
  assert.equal(enabledOf(), 0)

  const on = await h.call('POST', '/memory-core/api/skills/update', { name: 'demo-skill', action: 'enable' })
  assert.equal(on.status, 200)
  assert.equal(on.json.ok, true)
  assert.equal(enabledOf(), 1)
  closeDb(h.db)
})

test('缺 webServer 服务时安装失败但不抛（headless 场景）', () => {
  const ctx = {
    inject: () => {
      throw new Error('service webServer is not available')
    },
  }
  const ok = installApi(ctx, { store: null, prompts: null, ledger: null, runtime: {}, host: {}, config: {} })
  assert.equal(ok, false)
})
