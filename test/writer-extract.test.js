import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { EXTRACT_DEFAULTS, buildExtractRequest, callExtractLlm, extractJson, extractSession, markExtracted, noteSessionActivity, parseExtraction, planAutoExtract, routeOf } from '../lib/extract.js'
import { Recall } from '../lib/recall.js'
import { Store } from '../lib/store.js'
import { approveSuggestion, archiveSuggestion, rejectSuggestion, relate, restoreSuggestion, scanSecrets, similarity, sweepSuggestions, writeMemory } from '../lib/writer.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-m3-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const recall = new Recall(store)
  return { db, store, recall, cwd: '/tmp/example-workspace' }
}

test('隐私拦截：密钥/token/私钥形态一律拒写', () => {
  const clean = scanSecrets('这条记忆没有任何敏感信息，只是普通约定。')
  assert.equal(clean.clean, true)
  for (const sample of [
    'key is sk-abcdefghijklmnopqrstuvwx',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'as_sk_abcdefghij1234',
    '密码: hunter2secret',
    '-----BEGIN RSA PRIVATE KEY-----',
  ]) {
    assert.equal(scanSecrets(sample).clean, false, `应拦截：${sample}`)
  }
})

test('写入分轨：规则进待确认队列，项目进展直写', () => {
  const { db, store, recall, cwd } = fixture()
  const rule = writeMemory({ store, recall, cwd, input: { content: '提交前必须跑 lint，不要跳过。', track: 'memory', kind: 'rule' } })
  assert.equal(rule.status, 'queued')
  assert.equal(store.counts().units, 0)
  assert.equal(store.listSuggestions({ status: 'pending' }).length, 1)

  const progress = writeMemory({ store, recall, cwd, input: { content: '今天完成了检索层的单元测试。', track: 'project', kind: 'progress' } })
  assert.equal(progress.status, 'written')
  assert.equal(store.counts().units, 1)
  const row = store.getUnit(progress.id)
  assert.equal(row.scope, 'project:1a264d53adb3')
  closeDb(db)
})

test('写入幂等与拒绝：重复内容返回 duplicate，敏感内容 rejected', () => {
  const { db, store, recall, cwd } = fixture()
  const first = writeMemory({ store, recall, cwd, input: { content: '统一用 cross_project 封装，不要裸用 antd。', track: 'project', kind: 'progress' } })
  assert.equal(first.status, 'written')
  const second = writeMemory({ store, recall, cwd, input: { content: '统一用 cross_project 封装，不要裸用 antd。', track: 'project', kind: 'progress' } })
  assert.equal(second.status, 'duplicate')
  assert.equal(second.id, first.id)
  const bad = writeMemory({ store, recall, cwd, input: { content: 'key: sk-abcdefghijklmnopqrstuvwx' } })
  assert.equal(bad.status, 'rejected')
  closeDb(db)
})

test('相似度与关系判定：同一件事换个说法 → update 而不是新增', () => {
  const { db, store, recall, cwd } = fixture()
  writeMemory({ store, recall, cwd, input: { content: '示例项目：底部按钮直接用 @/components/FooterButton，不要手写布局。', track: 'project', kind: 'progress' } })
  const rel = relate({ store, recall, content: '示例项目底部按钮不要手写布局，直接用 @/components/FooterButton。', track: 'project', scope: 'project:1a264d53adb3', cwd })
  assert.ok(['update', 'related'].includes(rel.relation), `实际 ${rel.relation}`)
  assert.ok(rel.candidates.length >= 1)
  assert.ok(similarity('底部按钮用 FooterButton', '底部按钮直接 FooterButton') > 0.4)
  closeDb(db)
})

test('待确认队列：采纳落库、拒绝留痕、超期自动归档', () => {
  const { db, store, recall, cwd } = fixture()
  const queued = writeMemory({ store, recall, cwd, input: { content: '推理等级要在 settings 里显式声明。', track: 'memory', kind: 'rule' } })
  const ok = approveSuggestion({ store, id: queued.id, overrides: { track: 'key', content: '推理等级必须在 settings 里显式声明（否则选择器为空）。' } })
  assert.equal(ok.ok, true)
  const unit = store.getUnit(ok.id)
  assert.equal(unit.track, 'key')
  assert.ok(unit.content.includes('显式声明'))
  assert.equal(store.listSuggestions({ status: 'approved' }).length, 1)

  const queued2 = writeMemory({ store, recall, cwd, input: { content: '另一个需要确认的规则条目。', track: 'memory', kind: 'rule' } })
  assert.equal(rejectSuggestion({ store, id: queued2.id, reason: '太笼统' }).ok, true)
  assert.equal(store.listSuggestions({ status: 'rejected' }).length, 1)

  const queued3 = writeMemory({ store, recall, cwd, input: { content: '第三条待确认的建议。', track: 'memory', kind: 'rule' } })
  assert.equal(archiveSuggestion({ store, id: queued3.id }).ok, true)
  assert.equal(store.listSuggestions({ status: 'archived' }).length, 1)
  closeDb(db)
})

test('sweepSuggestions：只归档超期未处理的', () => {
  const { db, store, recall, cwd } = fixture()
  const old = writeMemory({ store, recall, cwd, input: { content: '很久以前的一条建议内容。', track: 'memory', kind: 'rule' } })
  store.db.prepare('UPDATE suggestions SET created_at = ? WHERE id = ?').run(Date.now() - 30 * 86400000, old.id)
  const fresh = writeMemory({ store, recall, cwd, input: { content: '刚刚产生的一条建议内容。', track: 'memory', kind: 'rule' } })
  const res = sweepSuggestions({ store, autoArchiveDays: 14 })
  assert.equal(res.archived, 1)
  const pending = store.listSuggestions({ status: 'pending' })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, fresh.id)
  closeDb(db)
})

test('提取：JSON 解析容忍围栏与前后废话，坏条目丢弃', () => {
  assert.deepEqual(extractJson('前言 {"a":1} 后语'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"items":[]}\n```'), { items: [] })
  assert.equal(extractJson('完全没有 JSON'), null)
  assert.deepEqual(extractJson('{"s":"含 } 的字符串"}'), { s: '含 } 的字符串' })

  const parsed = parseExtraction(
    JSON.stringify({
      items: [
        { content: '提交前必须跑 lint', track: 'memory', kind: 'rule', confidence: 0.9, evidence: '用户说' },
        { content: '', track: 'memory', kind: 'rule' },
        { content: '同一条内容重复出现', track: 'project', kind: 'progress' },
        { content: '同一条内容重复出现', track: 'project', kind: 'progress' },
        { content: '轨道写错的条目会被归到 project', track: '不存在', kind: '啥' },
      ],
    }),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.items.length, 3)
  assert.equal(parsed.items[0].track, 'memory')
  assert.equal(parsed.items[2].track, 'project')
  assert.equal(parsed.items[2].kind, 'progress')
})

test('callExtractLlm：只取 text-delta（跳过 reasoning），且显式传推理档位', async () => {
  const seen = []
  const llm = {
    stream(options) {
      seen.push(options)
      return (async function* () {
        yield { type: 'reasoning-delta', text: '想了很久但这段不该进结果' }
        yield { type: 'text-delta', text: '{"items":[]}' }
      })()
    },
  }
  const req = buildExtractRequest({ transcript: '用户: 你好\n助手: 你好', maxItems: 8 })
  assert.ok(req.system.includes('轨道定义'))
  const res = await callExtractLlm({ llm, route: { provider: 'p', model: 'm' }, request: req })
  assert.equal(res.ok, true)
  assert.equal(res.text, '{"items":[]}')
  assert.equal(seen[0].reasoningEffort, EXTRACT_DEFAULTS.distill.reasoningEffort)
  assert.ok(seen[0].maxTokens >= 8000, '预算必须充足（铁律）')
})

test('callExtractLlm：模型不支持档位时退回不带档位并记录降级', async () => {
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      if (options.reasoningEffort) throw new Error('model "m" does not support reasoning effort "off" (UNSUPPORTED_REASONING_EFFORT)')
      return (async function* () {
        yield { type: 'text-delta', text: '{"items":[]}' }
      })()
    },
  }
  const res = await callExtractLlm({ llm, route: { provider: 'p', model: 'm' }, request: buildExtractRequest({ transcript: 'x' }) })
  assert.equal(res.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].reasoningEffort, undefined)
  assert.ok(String(res.degraded).includes('不支持'))
})

test('callExtractLlm：档位下正文为空 → 自动退回默认档位（本机网关对 off/none 静默空返回）', async () => {
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      return (async function* () {
        if (options.reasoningEffort) {
          // 实测：网关不认该档位时不报错，只回 finish，正文与思考都是空
          yield { type: 'finish' }
          return
        }
        yield { type: 'text-delta', text: '{"items":[]}' }
      })()
    },
  }
  const res = await callExtractLlm({ llm, route: { provider: 'p', model: 'm' }, request: buildExtractRequest({ transcript: 'x' }) })
  assert.equal(res.ok, true)
  assert.equal(calls.length, 2, '应自动重试一次')
  assert.equal(calls[1].reasoningEffort, undefined, '重试不带档位')
  assert.ok(String(res.degraded).includes('正文为空'), res.degraded)
})

test('extractSession：产出全部进待确认队列（零直写），失败留痕', async () => {
  const { db, store, recall, cwd } = fixture()
  const llm = {
    stream: () =>
      (async function* () {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: [
              { content: '会话里定下的约定：所有检索必须带项目作用域。', track: 'key', kind: 'decision', confidence: 0.9, evidence: '用户拍板' },
              { content: '今天把提取链路接通了。', track: 'daily', kind: 'progress', confidence: 0.8, evidence: '助手总结' },
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
    enqueue: (item) => writeMemory({ store, recall, cwd, input: { content: item.content, track: item.track, kind: item.kind }, queueOnly: true }),
  })
  assert.equal(res.ok, true)
  assert.equal(store.counts().units, 0, '零直写：提取产物一律不落 units')
  assert.equal(store.listSuggestions({ status: 'pending' }).length, 2, 'key 与 daily 都进待确认队列')

  // 失败路径：无 JSON → 记失败计数
  const bad = {
    stream: () =>
      (async function* () {
        yield { type: 'text-delta', text: '我拒绝输出 JSON' }
      })(),
  }
  const failed = await extractSession({ store, transcript: '用户: 你好', llm: bad, route: { provider: 'p', model: 'm' } })
  assert.equal(failed.ok, false)
  assert.ok(String(failed.reason).includes('JSON'))
  assert.equal(store.getMeta('extract_failures'), '1')
  closeDb(db)
})

test('空闲规划：游标未推进、轮次不足、未到空闲时间都不触发', () => {
  const { db, store } = fixture()
  const sessionId = 's-x'
  noteSessionActivity({ store, sessionId, seq: 10, turns: 0 })
  const live = new Map([[sessionId, { lastSeen: Date.now(), seq: 10, turns: 5 }]])

  // 刚活动完：不触发
  assert.equal(planAutoExtract({ store, live, config: EXTRACT_DEFAULTS, now: Date.now() }).length, 0)

  // 空闲够久但没有轮次：不触发
  const later = Date.now() + 10 * 60000
  store.db.prepare('UPDATE sessions SET ingest_cursor = 0, turns_processed = 0 WHERE id = ?').run(sessionId)
  live.set(sessionId, { lastSeen: Date.now(), seq: 10, turns: 1 })
  assert.equal(planAutoExtract({ store, live, config: EXTRACT_DEFAULTS, now: later }).length, 0)

  // 空闲 + 有新轮次：触发
  live.set(sessionId, { lastSeen: Date.now(), seq: 10, turns: 5 })
  const due = planAutoExtract({ store, live, config: EXTRACT_DEFAULTS, now: later })
  assert.equal(due.length, 1)
  assert.equal(due[0].sessionId, sessionId)
  assert.equal(due[0].reason, 'idle')

  // 提取后游标前移：同一区间不再重复
  markExtracted({ store, sessionId, cursor: 10, turns: 5 })
  assert.equal(planAutoExtract({ store, live, config: EXTRACT_DEFAULTS, now: later }).length, 0)

  // auto=false 时永不触发
  live.set(sessionId, { lastSeen: Date.now(), seq: 20, turns: 9 })
  assert.equal(planAutoExtract({ store, live, config: { ...EXTRACT_DEFAULTS, auto: false }, now: later }).length, 0)
  closeDb(db)
})

test('routeOf：从会话 requestHeader 取模型路由', () => {
  assert.deepEqual(routeOf({ requestHeader: () => ({ config: { provider: 'tc-deepseek', model: 'm' } }) }), { provider: 'tc-deepseek', model: 'm' })
  assert.equal(routeOf({ requestHeader: () => ({}) }), null)
  assert.equal(routeOf({}), null)
})

// ── 待确认队列「本会话 / 全部」区分（线上 bug：工具写入的建议全成孤儿）────────
// 现象：mem_write 走的是 `origin: session:<会话>` 这条路径，没显式传 sessionId，
// 于是一律以 session_id = NULL 落库 —— 面板「本会话」永远是空的，条目全挤在「全部」里。
test('writeMemory：只给 origin 不给 sessionId 时，从 origin 推导归属会话', () => {
  const { db, store, recall, cwd } = fixture()
  const res = writeMemory({
    store,
    recall,
    cwd,
    input: { content: '工具写入的规则：提交前必须跑 lint。', track: 'memory', kind: 'rule' },
    origin: 'session:session-aaaa-bbbb',
  })
  assert.equal(res.status, 'queued')
  const row = store.db.prepare('SELECT session_id FROM suggestions WHERE id = ?').get(res.id)
  assert.equal(row.session_id, 'session-aaaa-bbbb', '建议必须带上归属会话，否则面板分不出「本会话」')
  assert.equal(store.listSuggestions({ status: 'pending', sessionId: 'session-aaaa-bbbb' }).length, 1)

  // 显式传 sessionId 时以显式值为准；工具无会话（origin=tool）时保持 NULL
  const explicit = writeMemory({ store, recall, cwd, input: { content: '另一条规则：显式会话优先。', track: 'memory', kind: 'rule' }, origin: 'session:session-old', sessionId: 'session-new' })
  assert.equal(store.db.prepare('SELECT session_id FROM suggestions WHERE id = ?').get(explicit.id).session_id, 'session-new')
  const noSession = writeMemory({ store, recall, cwd, input: { content: '第三条规则：没有会话上下文。', track: 'memory', kind: 'rule' }, origin: 'tool' })
  assert.equal(store.db.prepare('SELECT session_id FROM suggestions WHERE id = ?').get(noSession.id).session_id, null)
  closeDb(db)
})

test('backfillSuggestionSessions：历史孤儿建议按 origin 两种形态回填（幂等）', () => {
  const { db, store } = fixture()
  const at = Date.now()
  const insert = store.db.prepare("INSERT INTO suggestions (id, kind, target, payload, session_id, created_at, status) VALUES (?, 'memory', 'memory', ?, NULL, ?, 'pending')")
  // ① 会话提取路径（extract:）② 工具写入路径（session:）③ 无从考据的（保持 NULL）
  insert.run('bf-extract', JSON.stringify({ content: 'a', origin: 'extract:session-from-extract' }), at)
  insert.run('bf-session', JSON.stringify({ content: 'b', origin: 'session:session-from-tool' }), at)
  insert.run('bf-none', JSON.stringify({ content: 'c', origin: 'tool' }), at)

  assert.equal(store.backfillSuggestionSessions(), 2)
  const sid = (id) => store.db.prepare('SELECT session_id FROM suggestions WHERE id = ?').get(id).session_id
  assert.equal(sid('bf-extract'), 'session-from-extract')
  assert.equal(sid('bf-session'), 'session-from-tool', 'session: 前缀（历史 mem_write 产物）也必须能回填')
  assert.equal(sid('bf-none'), null)
  // 幂等：再跑一次没有可补的行
  assert.equal(store.backfillSuggestionSessions(), 0)

  // 面板「本会话」按会话过滤：两个会话各自只看自己的
  assert.deepEqual(store.listSuggestions({ status: 'pending', sessionId: 'session-from-tool' }).map((r) => r.id), ['bf-session'])
  assert.deepEqual(store.listSuggestions({ status: 'pending', sessionId: 'session-from-extract' }).map((r) => r.id), ['bf-extract'])
  assert.equal(store.listSuggestions({ status: 'pending', sessionId: 'all' }).length, 3)
  closeDb(db)
})

test('restoreSuggestion：归档可逆（归档 → 恢复回待确认 → 可再归档）', () => {
  const { db, store, recall, cwd } = fixture()
  const res = writeMemory({ store, recall, cwd, input: { content: '归档恢复用例：先归档再恢复。', track: 'memory', kind: 'rule' }, origin: 'session:s-1' })
  assert.equal(archiveSuggestion({ store, id: res.id }).ok, true)
  assert.equal(store.listSuggestions({ status: 'archived' }).length, 1)
  assert.equal(store.listSuggestions({ status: 'pending' }).length, 0)

  const back = restoreSuggestion({ store, id: res.id })
  assert.equal(back.ok, true)
  assert.equal(store.listSuggestions({ status: 'pending' }).map((r) => r.id).join(), res.id)
  assert.equal(store.listSuggestions({ status: 'archived' }).length, 0)
  // 未归档的不能再恢复（幂等保护），未知 id 明确报错
  assert.equal(restoreSuggestion({ store, id: res.id }).ok, false)
  assert.equal(restoreSuggestion({ store, id: 'nope' }).ok, false)
  closeDb(db)
})
