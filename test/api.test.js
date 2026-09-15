import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installApi } from '../lib/api.js'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { PromptManager } from '../lib/prompts.js'
import { Store } from '../lib/store.js'
import { approveSuggestion, archiveSuggestion, rejectSuggestion, sweepSuggestions, writeMemory } from '../lib/writer.js'
import { Recall } from '../lib/recall.js'

/** 假 webServer：捕获注册的路由，返回可控的 req/res。 */
function harness() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-api-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const recall = new Recall(store)
  const prompts = new PromptManager(store)
  const ledger = { snapshot: () => ({ totals: { residentTokens: 10, recallTokens: 5, cards: 1, turns: 3, hitTurns: 2 } }) }
  const runtime = {
    writer: {
      writeMemory: (a) => writeMemory({ store, recall, ...a }),
      approveSuggestion: (a) => approveSuggestion({ store, ...a }),
      rejectSuggestion: (a) => rejectSuggestion({ store, ...a }),
      archiveSuggestion: (a) => archiveSuggestion({ store, ...a }),
    },
    extractNow: async () => ({ ok: true, queued: 2 }),
    steer: () => true,
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
  return { db, store, recall, prompts, call }
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

test('缺 webServer 服务时安装失败但不抛（headless 场景）', () => {
  const ctx = {
    inject: () => {
      throw new Error('service webServer is not available')
    },
  }
  const ok = installApi(ctx, { store: null, prompts: null, ledger: null, runtime: {}, host: {}, config: {} })
  assert.equal(ok, false)
})
