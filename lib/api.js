/**
 * 宿主 HTTP API（设计 §12.1）：给 Web 面板与红点角标提供数据与操作。
 *
 * 注册方式：`ctx.inject(['webServer'], (webCtx) => webCtx.webServer.register({ kind:'prefix', path, handler }))`
 * （dsh 0.1.5-rc.1 的契约：`register({kind:'exact'|'prefix', path, handler})` 返回 disposer；
 * 同一 (kind,path) 重复注册会抛——所以整块注册包在 try/catch 里，绝不阻断宿主）。
 *
 * 路由表（前缀 `/memory-core/api`）：
 *   GET  /status                          健康度 + 计数 + 注入账本 + 提取健康
 *   GET  /badge                           待确认/提示词/技能等角标计数
 *   GET  /suggestions?status=&kind=       待确认队列
 *   POST /suggestions/approve             { id|ids, overrides? }
 *   POST /suggestions/reject              { id|ids, reason? }
 *   POST /suggestions/archive             { id|ids }
 *   POST /extract                         { sessionId? }
 *   GET  /prompts?enabled=1               提示词库
 *   GET  /prompts/active?sessionId=       活跃注入
 *   POST /prompts/inject                  { id, rounds?, every?, sessionId?, immediate? }
 *   POST /prompts/stop                    { id|injectionId|all, sessionId? }
 *   GET  /memory?track=&scope=&status=    记忆列表（面板用）
 *   GET  /memory/get?id=                  单条全文
 *   POST /memory/update                   { id, content?, track?, kind?, action? }
 *   GET  /evolution                       上次演化报告
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { health } from './health.js'
import { dshHome, projectHash } from './paths.js'

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req, maxBytes = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * 装配 API。
 * @param {any} ctx
 * @param {{ store: any, recall: any, prompts: any, ledger: any, runtime: any, host: any, config: any }} deps
 */
export function installApi(ctx, deps) {
  const { store, prompts, ledger, runtime, host, config = {} } = deps
  const base = config.apiBase ?? '/memory-core/api'
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const handler = async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.slice(base.length) || '/'
        const method = req.method ?? 'GET'
        try {
          if (method === 'GET' && (path === '/status' || path === '/')) {
            const h = health(store, host)
            return sendJson(res, 200, {
              ok: true,
              host: h.host,
              counts: h.counts,
              backup: h.latestBackup,
              injection: ledger?.snapshot?.(null) ?? null,
              extraction: {
                failures: Number(store.getMeta('extract_failures', '0')),
                degraded: store.getMeta('extract_degraded', 'false') === 'true',
                lastSuccessAt: store.getMeta('extract_last_success_at', null),
                lastFailure: store.getMeta('extract_last_failure', null),
                itemsTotal: Number(store.getMeta('extract_items_total', '0')),
              },
              evolution: (() => {
                try {
                  return JSON.parse(store.getMeta('evolve_last_run', 'null'))
                } catch {
                  return null
                }
              })(),
            })
          }

          if (method === 'GET' && path === '/badge') {
            const pending = store.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending'").get()
            const promptsActive = store.db.prepare('SELECT COUNT(*) AS n FROM prompt_injections WHERE active = 1').get()
            return sendJson(res, 200, {
              suggestions: Number(pending?.n ?? 0),
              todoSuggestions: Number(store.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending' AND kind = 'todo'").get()?.n ?? 0),
              skills: Number(store.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending' AND kind = 'skill'").get()?.n ?? 0),
              prompts: Number(promptsActive?.n ?? 0),
              extracting: runtime?.extracting === true,
            })
          }

          if (method === 'GET' && path === '/suggestions') {
            const status = url.searchParams.get('status') ?? 'pending'
            const kind = url.searchParams.get('kind')
            const rows = store.listSuggestions({
              status,
              kind,
              sessionId: url.searchParams.get('sessionId'),
              limit: Number(url.searchParams.get('limit') ?? 100),
            })
            return sendJson(res, 200, {
              entries: rows.map((r) => {
                let payload = {}
                try {
                  payload = JSON.parse(r.payload)
                } catch {
                  payload = {}
                }
                return { id: r.id, kind: r.kind, target: r.target, status: r.status, sessionId: r.session_id, createdAt: r.created_at, ...payload }
              }),
            })
          }

          if (method === 'POST' && path.startsWith('/suggestions/')) {
            const action = path.slice('/suggestions/'.length)
            const body = await readBody(req)
            const ids = body.ids ?? (body.id ? [body.id] : [])
            if (ids.length === 0) return sendJson(res, 400, { ok: false, message: '缺少 id' })
            const results = []
            for (const id of ids) {
              if (action === 'approve') results.push({ id, ...runtime.writer.approveSuggestion({ id, overrides: body.overrides ?? {} }) })
              else if (action === 'reject') results.push({ id, ...runtime.writer.rejectSuggestion({ id, reason: body.reason ?? null }) })
              else if (action === 'archive') results.push({ id, ...runtime.writer.archiveSuggestion({ id }) })
              else return sendJson(res, 404, { ok: false, message: `未知动作 ${action}` })
            }
            return sendJson(res, 200, { ok: true, results })
          }

          if (method === 'POST' && path === '/extract') {
            const body = await readBody(req)
            const sessionId = body.sessionId ?? null
            const res2 = sessionId && runtime.extractNow ? await runtime.extractNow(sessionId, { reason: 'api' }) : { ok: false, reason: '缺少 sessionId' }
            return sendJson(res, 200, res2)
          }

          if (method === 'GET' && path === '/todos') {
            const todoSession = url.searchParams.get('sessionId')
            const todoScope = todoSession
              ? store.db.prepare('SELECT scope FROM sessions WHERE id = ?').get(todoSession)?.scope ?? null
              : null
            const rows = deps.runtime?.todos?.list({
              track: url.searchParams.get('track'),
              scope: todoScope,
              cwd: url.searchParams.get('cwd'),
              status: url.searchParams.get('status'),
              all: url.searchParams.get('all') === '1',
              past: url.searchParams.get('past') === '1',
              expired: url.searchParams.get('expired') === '1',
              limit: Number(url.searchParams.get('limit') ?? (url.searchParams.get('all') === '1' ? 200 : 8)),
            }) ?? []
            return sendJson(res, 200, {
              reminder: deps.runtime?.todos?.reminderLine({ cwd: url.searchParams.get('cwd') }) ?? null,
              entries: rows.map((r) => ({
                id: r.id,
                track: r.track,
                scope: r.scope,
                day: r.day,
                content: r.content,
                quadrant: r.quadrant,
                due: r.due,
                status: r.status,
                category: r.category,
                createdAt: r.created_at,
                doneAt: r.done_at ?? null,
              })),
            })
          }
          if (method === 'POST' && path === '/todos/update') {
            const body = await readJson(req)
            const tm = deps.runtime?.todos
            if (!tm) return sendJson(res, 500, { ok: false, message: '待办模块未初始化' })
            const res2 = body.action === 'done' ? tm.done(body.id) : body.action === 'remove' ? tm.remove(body.id) : tm.update(body.id, body)
            return sendJson(res, 200, res2)
          }
          if (method === 'GET' && path === '/skills') {
            const sm = deps.runtime?.skills
            if (!sm) return sendJson(res, 200, { entries: [] })
            sm.scan()
            const rows = sm.list({
              q: url.searchParams.get('q'),
              enabledOnly: url.searchParams.get('enabled') === '1',
              source: url.searchParams.get('source'),
            })
            return sendJson(res, 200, {
              entries: rows.map((r) => ({ name: r.name, source: r.source, description: r.description, enabled: r.enabled === 1, bytes: r.bytes, updatedAt: r.updated_at })),
            })
          }
          if (method === 'POST' && path === '/skills/update') {
            const body = await readJson(req)
            const sm = deps.runtime?.skills
            if (!sm) return sendJson(res, 500, { ok: false, message: '技能模块未初始化' })
            const res2 = body.action === 'enable' || body.action === 'disable' ? sm.setEnabled(body.name, body.action === 'enable') : { ok: false, message: `未知动作 ${body.action}` }
            return sendJson(res, 200, res2)
          }
          if (method === 'GET' && path === '/prompts') {
            const enabledOnly = url.searchParams.get('enabled') === '1'
            const rows = prompts.listPrompts({
              category: url.searchParams.get('category'),
              q: url.searchParams.get('q'),
              enabledOnly,
            })
            return sendJson(res, 200, { entries: rows.map((p) => ({ ...p, body: p.body.length > 400 ? `${p.body.slice(0, 400)}…` : p.body })) })
          }

          if (method === 'GET' && path === '/prompts/active') {
            const sessionId = url.searchParams.get('sessionId')
            return sendJson(res, 200, { entries: prompts.listInjections({ sessionId: sessionId ?? undefined, activeOnly: true }) })
          }

          if (method === 'POST' && path === '/prompts/inject') {
            const body = await readBody(req)
            const p = prompts.getPrompt(body.id)
            if (!p) return sendJson(res, 404, { ok: false, message: `未找到提示词 ${body.id}` })
            const res2 = prompts.createInjection({
              promptId: p.id,
              title: body.title ?? p.name,
              content: body.content ?? p.body,
              rounds: body.rounds ?? 1,
              every: body.every ?? 1,
              sessionId: body.sessionId ?? null,
            })
            const nudged = body.immediate && body.sessionId ? runtime.steer?.(body.sessionId, `规则「${p.name}」已生效，请在本回合内遵循。`) === true : false
            return sendJson(res, 200, { ...res2, nudged })
          }

          if (method === 'POST' && path === '/prompts/stop') {
            const body = await readBody(req)
            if (body.all) return sendJson(res, 200, prompts.stopAll({ sessionId: body.sessionId ?? undefined }))
            if (body.injectionId) return sendJson(res, 200, prompts.stopInjection(body.injectionId))
            const p = prompts.getPrompt(body.id)
            if (!p) return sendJson(res, 404, { ok: false, message: `未找到提示词 ${body.id}` })
            let stopped = 0
            for (const inj of prompts.activeFor(p.id)) if (prompts.stopInjection(inj.id).ok) stopped += 1
            return sendJson(res, 200, { ok: true, stopped })
          }

          if (method === 'GET' && path === '/memory') {
            // scope 解析：显式 scope > 会话记录（sessions.scope）> cwd 推导 > global
            const wantTrack = url.searchParams.get('track')
            const cwd = url.searchParams.get('cwd')
            const sessionId = url.searchParams.get('sessionId')
            const sessionRow = sessionId ? store.db.prepare('SELECT scope FROM sessions WHERE id = ?').get(sessionId) : null
            const projectScope = sessionRow?.scope ?? (cwd ? `project:${projectHash(cwd)}` : null)
            let scope = url.searchParams.get('scope')
            if (!scope && wantTrack === 'daily') scope = 'global'
            else if (!scope && projectScope && (wantTrack === 'key' || wantTrack === 'project')) scope = projectScope
            const wantAll = url.searchParams.get('scope') === 'all'
            const full = url.searchParams.get('full') === '1'
            const rows = store.listUnits({
              track: wantTrack,
              scope: wantAll ? null : scope,
              status: url.searchParams.get('status') ?? 'active',
              limit: Number(url.searchParams.get('limit') ?? 50),
              offset: Number(url.searchParams.get('offset') ?? 0),
            })
            const projectCwd = projectScope
              ? store.db.prepare('SELECT cwd FROM projects WHERE hash = ?').get(String(projectScope).replace(/^project:[^@]*@?/, ''))?.cwd ?? null
              : null
            return sendJson(res, 200, {
              scope: scope ?? null,
              projectScope,
              projectCwd,
              entries: rows.map((r) => ({
                id: r.id,
                track: r.track,
                scope: r.scope,
                kind: r.kind,
                status: r.status,
                importance: r.importance,
                pinned: r.pinned === 1,
                version: r.version,
                day: r.day,
                gitBranch: r.git_branch,
                createdAt: r.created_at,
                ...(full ? { content: r.content } : {}),
                snippet: r.content.replace(/\s+/g, ' ').slice(0, full ? 400 : 200),
              })),
            })
          }

          if (method === 'GET' && path === '/memory/get') {
            const row = store.getUnit(url.searchParams.get('id'))
            if (!row) return sendJson(res, 404, { ok: false, message: '未找到' })
            return sendJson(res, 200, { ok: true, unit: row })
          }

          if (method === 'POST' && path === '/memory/update') {
            const body = await readBody(req)
            if (!body.id) return sendJson(res, 400, { ok: false, message: '缺少 id' })
            const action = body.action ?? 'edit'
            if (['archive', 'restore', 'pin', 'unpin'].includes(action)) {
              const status = action === 'archive' ? 'archived' : action === 'restore' ? 'active' : null
              const pinned = action === 'pin' ? 1 : action === 'unpin' ? 0 : null
              store.db
                .prepare('UPDATE units SET status = COALESCE(?, status), pinned = COALESCE(?, pinned), updated_at = ?, lamport = lamport + 1 WHERE id = ?')
                .run(status, pinned, Date.now(), body.id)
              store.logChange('unit', body.id, 'status', { status, pinned })
              return sendJson(res, 200, { ok: true, id: body.id, action })
            }
            const res2 = store.updateUnit(body.id, {
              content: body.content,
              track: body.track,
              kind: body.kind,
              reason: body.reason ?? 'panel edit',
              editedBy: 'panel',
            })
            return sendJson(res, res2.ok ? 200 : 404, res2)
          }

          if (method === 'GET' && path === '/agents') {
            // 全局规则：DSH 用户级 AGENTS.md（每个会话都会读到），面板只读展示
            const file = join(dshHome(), 'AGENTS.md')
            if (!existsSync(file)) return sendJson(res, 200, { ok: true, exists: false, path: file, content: '', bytes: 0 })
            const content = readFileSync(file, 'utf8')
            return sendJson(res, 200, { ok: true, exists: true, path: file, content, bytes: statSync(file).size })
          }

          if (method === 'GET' && path === '/evolution') {
            try {
              return sendJson(res, 200, { ok: true, report: JSON.parse(store.getMeta('evolve_last_run', 'null')) })
            } catch {
              return sendJson(res, 200, { ok: true, report: null })
            }
          }

          return sendJson(res, 404, { ok: false, message: `未知路由 ${method} ${path}` })
        } catch (error) {
          return sendJson(res, 500, { ok: false, message: error.message })
        }
      }
      const dispose = webCtx.webServer.register({ kind: 'prefix', path: base, handler })
      return () => {
        try {
          dispose?.()
        } catch {
          /* 忽略 */
        }
      }
    }, 'dsh-memory-core: web api')
    return true
  } catch (error) {
    console.warn(`[memory-core] HTTP API 注册失败（已忽略）：${error.message}`)
    return false
  }
}
