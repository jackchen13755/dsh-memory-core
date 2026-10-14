/**
 * 注入层（设计 §7）：常驻段 + 按轮卡片 + token 账本。
 *
 * 机制要点（读 dsh 0.1.5-rc.1 源码确认）：
 *   - `systemPrompt.context({name, order, text})` 的 text 在**每步组装提示词时**求值；
 *   - 组装结果与"上一次保留值"**按内容比对**，只有变化才会作为运行时快照追加一条 user 消息
 *     → 所以"文本不变 = 零成本"，这正是常驻段要稳定、按轮卡片要有阈值的原因；
 *   - 组装发生在 `agent/pre-step` 瀑布**之前**，因此按轮卡片的 query 来自
 *     `session/event`（`user/message`）缓存 —— 该事件先于组装触发。
 *
 * 预算（设计 §7 / M2 验收）：常驻段 ≤1200 token（默认 600+目录），按轮卡片 ≤400 token。
 */
import { projectHash } from './paths.js'

/** 粗略 token 估算：中文约 1 token / 1.5 字，ASCII 约 1 token / 4 字符（保守偏大）。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

/**
 * 按预算装箱文本行列表（对标 hindsight Stage 4 token 截断）。
 *
 * 装箱策略：**装不下就跳过、继续尝试后面的行**（skip-and-continue）。
 *   - 一条超长行不会吃掉它后面本来装得下的行（旧实现是"超预算即 break"）；
 *   - 一条都装不下时保底输出第一条（按预算截断），调用方不会拿到空段；
 *   - 有折叠提示时先为它留出预算，保证提示本身不会被挤掉；
 *   - 预算极紧（连一条完整行都装不下）时：先保底一条截断行，再谈提示 → 宁可丢提示，也不给空段。
 *
 * @returns {{lines: string[], tokens: number, dropped: number, fellBack: boolean}}
 *   dropped = 被跳过的行数；fellBack = 本轮走了"保底输出第一条"分支（该行是截断的，不是完整条目）。
 *   原字段 {lines, tokens, dropped} 语义与结构保持不变，fellBack 为附加信号。
 */
export function trimToBudget(lines, budgetTokens, { foldNote = true } = {}) {
  const budget = Number.isFinite(Number(budgetTokens)) ? Math.max(0, Math.floor(Number(budgetTokens))) : 0
  const head = Array.isArray(lines) ? [...lines] : []
  if (head.length === 0) return { lines: [], tokens: 0, dropped: 0, fellBack: false }

  /** 把一行截到剩余预算内（estimateTokens 随内容单调递增，逐字收缩必收敛）。 */
  const fitToBudget = (line, remaining) => {
    const raw = String(line ?? '')
    if (remaining <= 0) return ''
    if (estimateTokens(raw) + 1 <= remaining) return raw
    let cut = raw
    while (cut.length > 0 && estimateTokens(cut) + 1 > remaining) cut = cut.slice(0, -1)
    if (cut.length === 0) return raw.slice(0, 1)
    return cut === raw ? raw : `${cut.replace(/\s+$/, '')}…`
  }

  // 折叠提示的文案依赖 dropped 计数，先按"全丢"估算它的开销；真实 dropped 只会更小。
  const noteFor = (dropped) => `…（另有 ${dropped} 条，用 mem_search 检索）`
  const wantsNote = foldNote === true && head.length > 1
  const noteCost = wantsNote ? estimateTokens(noteFor(head.length - 1)) + 1 : 0
  const room = Math.max(0, budget - noteCost)

  const out = []
  let used = 0
  let skipped = 0
  let fellBack = false
  for (const line of head) {
    const t = estimateTokens(line) + 1
    if (used + t <= room) {
      out.push(line)
      used += t
    } else {
      skipped += 1
    }
  }

  // 保底：一条都没装下（唯一一条超预算 / 预算极紧）→ 输出第一条的截断版，调用方不会拿到空段。
  // 保底行是"已列出"，因此不计入 dropped；它背后的那一行从跳过列表里扣除。
  if (out.length === 0) {
    const first = fitToBudget(head[0], budget)
    if (first.length > 0) {
      out.push(first)
      used += estimateTokens(first) + 1
      skipped = Math.max(0, skipped - 1)
      fellBack = true
    }
  }

  // 折叠提示：真实 dropped ≤ 预留时用的上界 → 提示开销必然还在预算内。
  if (skipped > 0 && wantsNote && used + noteCost <= budget) {
    out.push(noteFor(skipped))
    used += estimateTokens(noteFor(skipped)) + 1
  }
  return { lines: out, tokens: used, dropped: skipped, fellBack }
}

/**
 * 会话态：本轮 query、已注入过的 id、账本计数。
 * 进程内内存态即可（重启后从头开始，不影响正确性）。
 */
export class InjectionLedger {
  constructor() {
    this.sessions = new Map()
    this.totals = { residentTokens: 0, residentRenders: 0, recallTokens: 0, recallSections: 0, cards: 0, turns: 0, hitTurns: 0 }
  }

  session(id) {
    if (!id) return null
    let s = this.sessions.get(id)
    if (!s) {
      s = { id, query: null, queryAt: 0, seen: new Set(), turns: 0, hitTurns: 0, missedStreak: 0, recallTokens: 0, cards: 0 }
      this.sessions.set(id, s)
    }
    return s
  }

  noteUserMessage(sessionId, text) {
    const s = this.session(sessionId)
    if (!s) return
    s.query = String(text ?? '').slice(0, 2000)
    s.queryAt = Date.now()
    s.turns += 1
    this.totals.turns += 1
  }

  noteResident(tokens) {
    this.totals.residentTokens = tokens
    this.totals.residentRenders += 1
  }

  noteRecall(sessionId, { tokens, cards, injected, evidence = null }) {
    const s = this.session(sessionId)
    if (injected) {
      this.totals.recallTokens += tokens
      this.totals.recallSections += 1
      this.totals.cards += cards
      this.totals.hitTurns += 1
    }
    // 证据达标记为"有命中"（即使卡片都已见过），否则累加空转计数；
    // 连续空转达阈值后本会话不再触发（省 token）。
    const hit = evidence ?? injected
    if (s) {
      if (hit) {
        s.hitTurns += 1
        s.missedStreak = 0
      } else {
        s.missedStreak += 1
      }
      if (injected) {
        s.recallTokens += tokens
        s.cards += cards
      }
    }
  }

  snapshot(sessionId = null) {
    const s = sessionId ? this.sessions.get(sessionId) : null
    return {
      totals: { ...this.totals },
      session: s
        ? { id: s.id, turns: s.turns, hitTurns: s.hitTurns, cards: s.cards, recallTokens: s.recallTokens, seenIds: s.seen.size, missedStreak: s.missedStreak }
        : null,
      sessions: this.sessions.size,
    }
  }
}

/** 从会话消息里取最后一条真人文本（与 dsh 的 textOf 同思路，忽略插件注入的快照）。 */
export function humanText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    if (m.source && m.source.kind === 'plugin') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
      if (text) return text
    }
  }
  return ''
}

const RESIDENT_KINDS = new Set(['rule', 'preference'])

/**
 * 常驻段（设计 §7.1）：
 *   ① 规则/偏好类记忆（kind ∈ {rule, preference} 或 pinned）
 *   ② 索引目录：未常驻条目的"一行标题"，专治"根本不知道有这回事"
 */
export function renderResidentSection({ store, cwd = null, config = {} }) {
  const resident = {
    rules: true,
    indexCatalog: true,
    maxCatalogLines: 40,
    rulesBudgetTokens: 600,
    catalogBudgetTokens: 500,
    maxRuleChars: 160,
    budgetTokens: 1200,
    ...(config.resident ?? {}),
  }
  if (resident.rules === false && resident.indexCatalog === false) return { text: '', tokens: 0, rules: 0, catalog: 0 }

  const scopes = cwd ? [`project:${projectHash(cwd)}`, 'global'] : ['global']
  const placeholders = scopes.map(() => '?').join(',')
  const rows = store.db
    .prepare(
      `SELECT id, track, scope, kind, pinned, content, meta, created_at FROM units
        WHERE status = 'active' AND scope IN (${placeholders})
        ORDER BY pinned DESC, importance DESC, created_at DESC`,
    )
    .all(...scopes)

  const head = []
  const rest = []
  for (const row of rows) {
    const isResident = resident.rules !== false && (row.pinned === 1 || RESIDENT_KINDS.has(row.kind))
    if (isResident) head.push(row)
    else rest.push(row)
  }

  /** 一行摘要：优先用 meta.summary（key 轨的渐进式披露前缀），否则压平正文。 */
  const oneLine = (row, max) => {
    const meta = safeJson(row.meta)
    const raw = (meta.summary ? String(meta.summary) : row.content.replace(/\s+/g, ' ')).replace(/\s+/g, ' ').trim()
    return raw.length > max ? `${raw.slice(0, max)}…` : raw
  }

  const parts = []
  let rules = 0
  let catalog = 0
  let rulesTokens = 0
  let catalogTokens = 0

  if (head.length > 0) {
    const lines = ['【规则与偏好（常驻，必须遵守）】']
    for (const row of head) {
      lines.push(`- [mem:${row.id}|${row.kind ?? row.track}] ${oneLine(row, resident.maxRuleChars)}`)
    }
    const trimmed = trimToBudget(lines, resident.rulesBudgetTokens)
    rulesTokens = trimmed.tokens
    // 装箱后实际留下的完整条目数（标题行与保底截断行都不算）
    rules = (trimmed.fellBack ? trimmed.lines.filter((l) => !l.endsWith('…')) : trimmed.lines).filter((l) => l.startsWith('- ')).length
    parts.push(...trimmed.lines)
  }

  if (resident.indexCatalog !== false && rest.length > 0) {
    // 目录按轨道分优先级：真正常用的长期事实（key/memory/user）优先，
    // daily 日志量大且单行信息量低 —— 只列最近若干条，避免把目录挤满。
    const TRACK_PRIORITY = { key: 0, memory: 1, user: 2, project: 3, daily: 4 }
    const maxDaily = resident.maxDailyLines ?? 5
    const sorted = [...rest].sort((a, b) => {
      const pa = TRACK_PRIORITY[a.track] ?? 9
      const pb = TRACK_PRIORITY[b.track] ?? 9
      if (pa !== pb) return pa - pb
      return b.created_at - a.created_at
    })
    let dailyShown = 0
    let skippedDaily = 0
    const picked = []
    for (const row of sorted) {
      if (picked.length >= resident.maxCatalogLines) break
      if (row.track === 'daily') {
        if (dailyShown >= maxDaily) {
          skippedDaily += 1
          continue
        }
        dailyShown += 1
      }
      picked.push(row)
    }
    const lines = ['【本范围记忆目录（标题，正文用 mem_get <id> 取）】']
    for (const row of picked) {
      lines.push(`- [mem:${row.id}|${row.track}] ${oneLine(row, 60)}`)
    }
    const hidden = rest.length - picked.length
    if (hidden > 0) lines.push(`（另有 ${hidden} 条未列出${skippedDaily > 0 ? `（含 ${skippedDaily} 条更早的每日日志）` : ''}，用 mem_search 检索）`)
    const trimmed = trimToBudget(lines, resident.catalogBudgetTokens)
    catalogTokens = trimmed.tokens
    // 与 rules 口径一致：只数实际装箱的完整目录条目行
    catalog = (trimmed.fellBack ? trimmed.lines.filter((l) => !l.endsWith('…')) : trimmed.lines).filter((l) => l.startsWith('- ')).length
    parts.push(...trimmed.lines)
  }

  if (parts.length === 0) return { text: '', tokens: 0, rules: 0, catalog: 0 }
  const header = '【记忆（dsh-memory-core）】接到任务先 mem_search 检索未注入的项目日志与每日日志。'
  let text = `${header}\n${parts.join('\n')}`
  let tokens = estimateTokens(text)
  if (tokens > resident.budgetTokens) {
    const cut = trimToBudget(text.split('\n'), resident.budgetTokens)
    text = cut.lines.join('\n')
    tokens = estimateTokens(text)
  }
  return { text, tokens, rules, catalog, rulesTokens, catalogTokens, dropped: Math.max(0, rest.length - catalog) }
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

/**
 * 按轮卡片（设计 §7.2）：证据达标才注入，最多 `maxCards` 张，同会话按 id 去重，
 * 连续 `idleTurnsStop` 轮无命中后本会话不再触发。
 */
export function renderRecallSection({ store, recall, ledger, sessionId, cwd = null, config = {} }) {
  const cfg = { perTurn: true, maxCards: 3, injectBudgetTokens: 400, threshold: 0.62, idleTurnsStop: 5, firstTurnBoost: true, ...(config.recall ?? {}) }
  const empty = { text: '', tokens: 0, cards: 0, injected: false, reason: 'off', computed: false }
  if (cfg.perTurn === false) return empty
  const s = ledger.session(sessionId)
  if (!s || !s.query) return { ...empty, reason: 'no-query' }

  // ① 同一轮内保持稳定：一次组装的结果会被复用，直到出现新的用户消息。
  //    （否则多步组装会把卡片"消费"掉，文本从卡片变空，运行时快照被判定为变化 → 抖动）
  const key = `${s.queryAt}|${s.query}`
  if (s.recallCache && s.recallCache.key === key) return s.recallCache.value

  if (s.missedStreak >= (cfg.idleTurnsStop ?? 5)) {
    const value = { ...empty, reason: 'idle-stop' }
    s.recallCache = { key, value }
    return value
  }

  const scopes = cwd ? [`project:${projectHash(cwd)}`, 'global'] : ['global']
  const res = recall.search({ query: s.query, scopes, k: Math.max(cfg.maxCards * 2, 6), log: false, sessionId })
  let value
  if (!res.evidence.inject) {
    value = { ...empty, reason: 'evidence-below-threshold', ms: res.ms }
  } else {
    const fresh = res.hits.filter((h) => !s.seen.has(h.id)).slice(0, cfg.maxCards)
    if (fresh.length === 0) {
      value = { ...empty, reason: 'all-seen', ms: res.ms }
    } else {
      const lines = [`【本轮相关记忆（自动召回）】query: ${s.query.slice(0, 60)}`]
      for (const h of fresh) {
        const chans = Object.keys(h.channels ?? {}).join('+')
        lines.push(`[mem:${h.id} | ${h.track}/${h.kind ?? '-'} | ${chans}]`)
        lines.push(h.snippet.length > 200 ? `${h.snippet.slice(0, 200)}…` : h.snippet)
        lines.push(`→ mem_get ${h.id} 取全文`)
      }
      const trimmed = trimToBudget(lines, cfg.injectBudgetTokens, { foldNote: false })
      const text = trimmed.lines.join('\n')
      for (const h of fresh) s.seen.add(h.id)
      value = { text, tokens: estimateTokens(text), cards: fresh.length, injected: true, ids: fresh.map((h) => h.id), ms: res.ms, computed: true }
    }
  }
  ledger.noteRecall(sessionId, { ...value, evidence: res.evidence.inject })
  s.recallCache = { key, value }
  return value
}
