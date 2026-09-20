/**
 * 写入路径（设计 §5）：隐私拦截 → 相似比对 → 分轨与确认策略 → 落库或进待确认队列。
 *
 * 四条纪律：
 *   1. **隐私优先**：命中密钥/token/私钥形态的内容直接拒绝，不落库（设计 §5.1）；
 *   2. **先比对后写**：写入前跑一次检索，标注"已存在相似条目"，能合并就不新增；
 *   3. **确认制**：规则/偏好/关键事实/全局轨 → 进 `suggestions` 队列等人工确认；
 *      只有项目与每日的进展类记录直写（设计 §5.1 分轨规则）；
 *   4. **可追溯**：每条写入都记 `changes`（同步用）与 `origin`（谁写的）。
 */
import { extractEntities } from './entities.js'
import { projectHash, sha1 } from './paths.js'
import { tokenize } from './tokens.js'

/** 密钥/token/私钥形态（命中即拒写，并回报命中的模式名）。 */
export const SECRET_PATTERNS = [
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'github-pat', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: 'github-fine-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'anysearch-key', re: /\bas_sk_[A-Za-z0-9]{10,}\b/ },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'password', re: /(密码|password|passwd)\s*[:=]\s*\S{6,}/i },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
]

export function scanSecrets(text) {
  const hits = []
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(String(text ?? ''))
    if (m) hits.push({ name, sample: `${m[0].slice(0, 8)}…` })
  }
  return { clean: hits.length === 0, hits }
}

/** 分轨规则（设计 §5.1）：哪些组合可以直写，其余一律进待确认。 */
export const DIRECT_WRITE_TRACKS = new Set(['project', 'daily'])
export const CONFIRM_KINDS = new Set(['rule', 'preference', 'decision', 'pitfall', 'fact', 'env'])

export function needsConfirm({ track, kind }) {
  if (!DIRECT_WRITE_TRACKS.has(track)) return true
  return CONFIRM_KINDS.has(kind) // 项目轨里的"规则/决策"同样要确认
}

export function resolveScope({ cwd = null, scope = null, track }) {
  if (scope) return scope
  if (track === 'project' || track === 'key') return cwd ? `project:${projectHash(cwd)}` : 'global'
  return 'global'
}

/** 词条 Jaccard 相似度（0..1），用于"是否已有相似条目"的启发式判定。 */
export function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 重叠系数（Szymkiewicz–Simpson）：交集 / 较短集合。中文 bigram 下比 Jaccard 更贴合"同一件事换个说法"。 */
export function overlapCoefficient(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  const [small, large] = A.size <= B.size ? [A, B] : [B, A]
  for (const t of small) if (large.has(t)) inter += 1
  return inter / small.size
}

/**
 * 判定与既有记忆的关系（无 LLM 的启发式；M3 演化阶段的 LLM 调和会再判一次）。
 * @returns {{ relation: string, candidates: Array<{id: string, snippet: string, similarity: number}> }}
 */
export function relate({ store, recall, content, track, scope, cwd }) {
  const hash = sha1(String(content).trim())
  const dup = store.db
    .prepare('SELECT id FROM units WHERE content_hash = ? AND status = \'active\'')
    .get(hash)
  const scopes = scope && scope !== 'global' ? [scope, 'global'] : [scope ?? 'global']
  const res = recall.search({ query: content, scopes, k: 5, log: false })
  const candidates = res.hits
    .filter((h) => h.content !== content)
    .map((h) => ({ id: h.id, snippet: h.snippet.slice(0, 120), similarity: Number(similarity(content, h.content).toFixed(3)) }))
    .sort((a, b) => b.similarity - a.similarity)
  if (dup) return { relation: 'duplicate', duplicateId: dup.id, candidates }
  const top = candidates[0]
  if (top && top.similarity >= 0.55) return { relation: 'update', candidates, targetId: top.id }
  if (top && top.similarity >= 0.25) return { relation: 'related', candidates, targetId: top.id }
  return { relation: 'unrelated', candidates }
}

/**
 * 从 origin 里解析归属会话（`session:<id>` / `extract:<id>`）。
 *
 * 工具写入（mem_write / mem_todo）只把会话写进 `origin`（形如 `session:<会话>`），
 * 没显式传 sessionId；不兜底推导的话建议会以 `session_id = NULL` 落库，
 * 面板「本会话 / 全部」就区分不出来（全成孤儿）。这里统一兜住。
 */
export function sessionIdFromOrigin(origin) {
  const m = /^(?:session|extract):(.+)$/.exec(String(origin ?? ''))
  const id = m && m[1] && m[1] !== 'session' ? m[1] : null
  return id
}

/**
 * 写一条记忆。
 * @returns {{ status: 'written'|'queued'|'duplicate'|'rejected', ... }}
 */
export function writeMemory({ store, recall, input, cwd = null, origin = 'tool', force = false, queueOnly = false, sessionId = null }) {
  const content = String(input.content ?? '').trim()
  if (!content) return { status: 'rejected', reason: '内容为空' }
  const secrets = scanSecrets(content)
  if (!secrets.clean) {
    return { status: 'rejected', reason: `命中敏感信息（${secrets.hits.map((h) => h.name).join(', ')}），已拒绝写入` }
  }

  const track = input.track ?? 'memory'
  const scope = resolveScope({ cwd, scope: input.scope ?? null, track })
  const kind = input.kind ?? 'fact'
  const meta = {
    tags: input.tags ?? [],
    alias: input.alias ?? [],
    ent: input.ent ?? extractEntities(content),
    summary: input.summary ?? null,
    source: input.source ?? null,
  }
  const relation = relate({ store, recall, content, track, scope, cwd })

  if (relation.relation === 'duplicate' && !force) {
    return { status: 'duplicate', id: relation.duplicateId, relation: relation.relation, candidates: relation.candidates }
  }

  const payload = { content, track, scope, kind, meta, relation: relation.relation, candidates: relation.candidates, origin, cwd }
  // 归属会话：优先用显式 sessionId；调用方只给了 `session:`/`extract:` 形态的 origin 时从 origin 推导
  const ownerSession = sessionId ?? sessionIdFromOrigin(origin)
  // queueOnly：会话提取路径专用 —— 无论轨道一律进待确认队列（设计 §5.3「零直写」）。
  if (queueOnly || (!force && needsConfirm({ track, kind }))) {
    const { id, inserted } = store.insertSuggestion({
      kind: 'memory',
      target: track,
      payload,
      status: 'pending',
      sessionId: ownerSession ?? null, // 归属会话：面板按会话区分待确认
    })
    return {
      status: inserted ? 'queued' : 'queued-duplicate',
      id,
      relation: relation.relation,
      candidates: relation.candidates,
      reason: queueOnly ? '会话提取一律进待确认队列' : '按分轨规则需人工确认',
    }
  }

  const { id, inserted } = store.insertUnit({
    track,
    scope,
    kind,
    content,
    meta,
    importance: kind === 'rule' ? 0.9 : kind === 'preference' ? 0.8 : 0.6,
    origin,
  })
  return { status: inserted ? 'written' : 'duplicate', id, relation: relation.relation, candidates: relation.candidates }
}

/** 项目轨：作用域跟着「当前打开的项目」走，而不是建议产生时那个项目。 */
export const PROJECT_TRACKS = new Set(['project', 'key'])

/**
 * 采纳时的作用域解析（"精确区分会话/项目"的落点）：
 *   1. 显式 scope 优先；
 *   2. project / key 轨 —— 用**当前打开项目**的作用域（`projectScope`），
 *      其次才退回建议产生时记下的 payload scope（跨会话/跨项目时它指的是别的项目）；
 *   3. 其余轨一律全局 —— project 轨的 scope 不能跟着条目跑到全局轨上
 *      （否则条目落在项目作用域里，面板五轨按 track+scope 过滤，哪一轨都看不见）。
 */
export function resolveApproveScope({ track, explicitScope = null, projectScope = null, payloadScope = null }) {
  if (explicitScope) return explicitScope
  if (PROJECT_TRACKS.has(track)) return projectScope ?? payloadScope ?? 'global'
  return payloadScope && !String(payloadScope).startsWith('project:') ? payloadScope : 'global'
}

/**
 * 采纳待确认的建议（可由人改轨/改文案/改 kind 后再采纳）。
 * `projectScope` = 采纳时**当前打开项目**的作用域（面板按 sessionId 反查后传入）。
 */
export function approveSuggestion({ store, id, overrides = {}, decidedBy = 'user', projectScope = null }) {
  const row = store.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id)
  if (!row) return { ok: false, message: `未找到建议 ${id}` }
  if (row.status !== 'pending') return { ok: false, message: `建议 ${id} 状态为 ${row.status}，无需处理` }
  let payload = {}
  try {
    payload = JSON.parse(row.payload)
  } catch {
    payload = {}
  }
  const merged = { ...payload, ...overrides }
  const track = overrides.track ?? merged.track ?? row.target ?? 'memory'
  const scope = resolveApproveScope({
    track,
    explicitScope: overrides.scope ?? null,
    projectScope,
    payloadScope: merged.scope ?? null,
  })
  const kind = overrides.kind ?? merged.kind ?? 'fact'
  const content = overrides.content ?? merged.content
  if (!content) return { ok: false, message: '建议内容为空' }

  const secrets = scanSecrets(content)
  if (!secrets.clean) return { ok: false, message: `命中敏感信息（${secrets.hits.map((h) => h.name).join(', ')}）` }

  const res = store.insertUnit({
    track,
    scope,
    kind,
    content,
    meta: merged.meta ?? null,
    importance: kind === 'rule' ? 0.9 : 0.6,
    origin: `suggestion:${id}`,
  })
  store.db
    .prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
    .run('approved', Date.now(), decidedBy, id)
  return { ok: true, id: res.id, inserted: res.inserted, track, scope, kind }
}

export function rejectSuggestion({ store, id, reason = null, decidedBy = 'user' }) {
  const row = store.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id)
  if (!row) return { ok: false, message: `未找到建议 ${id}` }
  store.db
    .prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ?, payload = ? WHERE id = ?')
    .run('rejected', Date.now(), decidedBy, JSON.stringify({ ...safeJson(row.payload), rejectReason: reason }), id)
  return { ok: true, id }
}

export function archiveSuggestion({ store, id, decidedBy = 'user' }) {
  const row = store.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id)
  if (!row) return { ok: false, message: `未找到建议 ${id}` }
  store.db.prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run('archived', Date.now(), decidedBy, id)
  return { ok: true, id }
}

/**
 * 把归档的建议放回待确认队列（面板「已归档」视图的「恢复」）。
 * 归档不是终态：只改状态，payload 原样保留，恢复后仍可采纳 / 拒绝 / 再归档。
 */
export function restoreSuggestion({ store, id, decidedBy = 'user' }) {
  const row = store.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id)
  if (!row) return { ok: false, message: `未找到建议 ${id}` }
  if (row.status !== 'archived') return { ok: false, message: `建议 ${id} 状态为 ${row.status}，只有已归档的才能恢复` }
  store.db.prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run('pending', null, decidedBy, id)
  return { ok: true, id }
}

/** 超期未处理的建议自动归档（设计 §5.4 队列烂尾治理）。 */
export function sweepSuggestions({ store, autoArchiveDays = 14, now = Date.now() }) {
  if (!autoArchiveDays || autoArchiveDays <= 0) return { archived: 0 }
  const cutoff = now - autoArchiveDays * 86400000
  const res = store.db
    .prepare("UPDATE suggestions SET status = 'archived', decided_at = ? WHERE status = 'pending' AND created_at < ?")
    .run(now, cutoff)
  return { archived: Number(res.changes ?? 0) }
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}
