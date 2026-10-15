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
 * 装箱结果里是否还剩「内容行」（`- ` 开头的条目/目录行）。
 * 只有标题行活着时算空段 —— 调用方应整段不发，别把「只有标题」的段落塞进常驻提示。
 */
function keptContentLines(lines) {
  return Array.isArray(lines) && lines.some((l) => String(l).startsWith('- '))
}

/**
 * 常驻段的总标题。**按内容**识别，不按「第一行」—— 总预算截断的 skip-and-continue 可能
 * 先把总标题自己丢掉，此时段标题会落到 index 0，按下标豁免就会把「只有段标题、一条条目
 * 都没有」的空段放行（N3）。
 */
const RESIDENT_TOTAL_HEADER = '【记忆（dsh-memory-core）】'

/**
 * 丢掉「只剩标题、一条条目都没有」的整段（总预算截断后的收尾，见 F5 / N3）。
 *
 * 总预算截断只按行装箱，可能把某段的条目全丢掉却留下它的标题，渲染出来就是一个
 * 只有标题的空段 —— 对模型是噪声，还让人以为「本范围确实没有规则」。段边界是下一个
 * `【…】` 标题；总标题无论排在哪一行都保留（它是常驻提示的入口说明，不是「可选段」）。
 *
 * 注意：「段内有内容」的判据是 `- ` 前缀（两段的正文行只有条目与折叠提示两种形态），
 * 将来若有段要放非 `- ` 开头的正文，这条判据要一起改。
 */
function dropOrphanSections(lines) {
  const out = []
  let sectionStart = -1
  let sectionHasEntry = false
  let sectionIsTotal = false
  const flush = () => {
    if (sectionStart >= 0 && !sectionHasEntry && !sectionIsTotal) out.length = sectionStart
  }
  for (const line of lines) {
    const text = String(line)
    if (text.startsWith('【')) {
      flush()
      sectionStart = out.length
      sectionHasEntry = false
      sectionIsTotal = text.startsWith(RESIDENT_TOTAL_HEADER)
    } else if (text.startsWith('- ')) {
      sectionHasEntry = true
    }
    out.push(text)
  }
  flush()
  return out
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
 * **预算 0 是唯一的例外，且是「关掉该段」的显式语义**（A2 备案）：`budget=0` 时返回空列表，
 * 不触发保底 —— 保底的本意是「预算再紧也让模型看到一条」，而 0 预算的正确含义是「这一段不要发」，
 * 硬塞一条截断行只会白占 token。**因此「不会拿到空段」这条承诺的前提是 `budget > 0`**；
 * 调用方若只交出标题行，应自行判断是否整段不发（见 renderResidentSection 的 keptContent 检查）。
 *
 * @returns {{lines: string[], tokens: number, dropped: number, fellBack: boolean, keptIndexes: number[]}}
 *   dropped = 被跳过的行数；fellBack = 本轮走了"保底输出第一条"分支（该行是截断的，不是完整条目）；
 *   keptIndexes = 装箱后保留的**输入行下标**（升序，与 lines 中的原始行一一对应；折叠提示行是合成的，
 *   不出现在这里）。调用方要判断"我关心的那几行留下了没有"时用它，**不要**去反解渲染出来的文本
 *   （N2：片段内容可以长得像结构行，反解会把不存在的 id 记进去）。
 *   原字段 {lines, tokens, dropped} 语义与结构保持不变，fellBack / keptIndexes 为附加信号。
 */
export function trimToBudget(lines, budgetTokens, { foldNote = true } = {}) {
  const budget = Number.isFinite(Number(budgetTokens)) ? Math.max(0, Math.floor(Number(budgetTokens))) : 0
  const head = Array.isArray(lines) ? [...lines] : []
  if (head.length === 0) return { lines: [], tokens: 0, dropped: 0, fellBack: false, keptIndexes: [] }

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
  const keptIndexes = []
  let used = 0
  let skipped = 0
  let fellBack = false
  for (let i = 0; i < head.length; i += 1) {
    const line = head[i]
    const t = estimateTokens(line) + 1
    if (used + t <= room) {
      out.push(line)
      keptIndexes.push(i)
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
      keptIndexes.push(0)
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
  return { lines: out, tokens: used, dropped: skipped, fellBack, keptIndexes }
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
  if (resident.rules === false && resident.indexCatalog === false) return { text: '', tokens: 0, rules: 0, catalog: 0, rulesTokens: 0, catalogTokens: 0, dropped: 0 }

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
    // 预算刚好只装下标题、装不下任何条目时**整段不发**：否则常驻提示里会出现一个只有标题、
    // 没有内容的空段 —— 对模型是纯噪声，还会让它以为「本范围确实没有规则」。
    // 计数值同步归零，与实际注入的内容一致（别让诊断口径和真实输出对不上）。
    if (keptContentLines(trimmed.lines)) {
      rulesTokens = trimmed.tokens
      // 装箱后实际留下的完整条目数（标题行与保底截断行都不算）
      rules = (trimmed.fellBack ? trimmed.lines.filter((l) => !l.endsWith('…')) : trimmed.lines).filter((l) => l.startsWith('- ')).length
      parts.push(...trimmed.lines)
    }
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
    // 同 rules 段：只有标题活下来就整段不发（见上面 keptContentLines 的说明）
    if (keptContentLines(trimmed.lines)) {
      catalogTokens = trimmed.tokens
      // 与 rules 口径一致：只数实际装箱的完整目录条目行
      catalog = (trimmed.fellBack ? trimmed.lines.filter((l) => !l.endsWith('…')) : trimmed.lines).filter((l) => l.startsWith('- ')).length
      parts.push(...trimmed.lines)
    }
  }

  // 整段都发不出去（预算为 0 / 只够装标题 / 没有内容）时的返回形状必须与正常路径**同构**：
  // 少字段会让消费方拿到 undefined（A2 的回用例就是这么发现的），所以这里补全两个计数字段。
  if (parts.length === 0) return { text: '', tokens: 0, rules: 0, catalog: 0, rulesTokens: 0, catalogTokens: 0, dropped: Math.max(0, rest.length - catalog) }
  const header = '【记忆（dsh-memory-core）】接到任务先 mem_search 检索未注入的项目日志与每日日志。'
  let text = `${header}\n${parts.join('\n')}`
  let tokens = estimateTokens(text)
  if (tokens > resident.budgetTokens) {
    // 总标题是常驻提示的**地标**（告诉模型「记忆在这里、用 mem_search 检索」），不允许被装箱丢掉：
    // skip-and-continue 优先装短行，长一点的总标题常常第一个被跳过，于是正文以段标题开头（N3）。
    // 做法是**先给它留出预算，其余内容再按剩余预算装箱** —— 这样"保住地标"不会让总 token 超预算
    // （旧写法是先整段装箱、再把总标题补回来，实测最多超 +19 token / +63%，O1）。
    // 预算连总标题都装不下时整段不发：宁可不发，也不硬塞一行超预算的地标。
    const headerCost = estimateTokens(header) + 1
    const restBudget = Math.max(0, resident.budgetTokens - headerCost)
    const lines = dropOrphanSections(trimToBudget(parts, restBudget).lines)
    // 只剩总标题也照发：那一行本身是可用指令（「接到任务先 mem_search …」），不是空段；
    // 此时 rules / catalog 均为 0，如实记账。
    const kept = resident.budgetTokens >= headerCost ? [header, ...lines] : []
    text = kept.join('\n')
    tokens = estimateTokens(text)
    // 计数必须跟着**截断后的真实内容**重算：否则会出现「正文里一条规则都没有，字段却报
    // rules=1 / rulesTokens=45」这种自相矛盾的诊断（F5），而 bin/mem.js 会把它原样打印给用户。
    // 归属按「最近一个段标题」判定：段标题自己也被丢掉时（极小预算），该行归到前一段，
    // 保证 rules + catalog 恒等于正文里的条目数（N3 的 b=19 就是这种残缺形态）。
    let inCatalog = false
    const rulesText = []
    const catalogText = []
    for (const line of kept) {
      if (line.startsWith('【')) inCatalog = line.startsWith('【本范围记忆目录')
      if (line.startsWith('- ')) (inCatalog ? catalogText : rulesText).push(line)
    }
    rules = rulesText.length
    catalog = catalogText.length
    rulesTokens = rules > 0 ? estimateTokens(rulesText.join('\n')) : 0
    catalogTokens = catalog > 0 ? estimateTokens(catalogText.join('\n')) : 0
  }
  // dropped = **两段合计**未列出的条目数（rules 段与 catalog 段同口径相加）。
  // 段内的「另有 N 条」折叠提示只报本段，两个数字不同源，别拿它们互相核对（N7）。
  return { text, tokens, rules, catalog, rulesTokens, catalogTokens, dropped: Math.max(0, head.length - rules) + Math.max(0, rest.length - catalog) }
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
      // 与 lines 一一对应的卡片 id（首行标题与指针行是 null）—— 用**结构**判断哪些卡片
      // 真的进了正文，不从渲染文本反解前缀：片段自身可能以 `[mem:` 开头（N2 实测会把
      // 不存在的 id 写进 seen，那条记忆本会话内再也不会注入）。
      const cardIds = [null]
      for (const h of fresh) {
        const chans = Object.keys(h.channels ?? {}).join('+')
        lines.push(`[mem:${h.id} | ${h.track}/${h.kind ?? '-'} | ${chans}]`)
        cardIds.push(h.id)
        lines.push(h.snippet.length > 200 ? `${h.snippet.slice(0, 200)}…` : h.snippet)
        cardIds.push(null)
        lines.push(`→ mem_get ${h.id} 取全文`)
        cardIds.push(null)
      }
      const trimmed = trimToBudget(lines, cfg.injectBudgetTokens, { foldNote: false })
      const text = trimmed.lines.join('\n')
      const keptIds = trimmed.keptIndexes.map((i) => cardIds[i]).filter(Boolean)
      if (keptIds.length === 0) {
        // 预算为 0（或非数值被归一成 0）= 用户明确关掉按轮卡片；预算太紧到一张卡片的标记行
        // 都装不下 = 同样什么都没注入。两种都**不能**谎报 injected，更不能把卡片标记成 seen。
        const zero = !Number.isFinite(Number(cfg.injectBudgetTokens)) || Number(cfg.injectBudgetTokens) <= 0
        value = { ...empty, ids: [], reason: zero ? 'budget-zero' : 'no-card-fits', ms: res.ms }
      } else {
        for (const id of keptIds) s.seen.add(id)
        value = { text, tokens: estimateTokens(text), cards: keptIds.length, injected: true, ids: keptIds, ms: res.ms, computed: true }
      }
    }
  }
  ledger.noteRecall(sessionId, { ...value, evidence: res.evidence.inject })
  s.recallCache = { key, value }
  return value
}
