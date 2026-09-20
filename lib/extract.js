/**
 * 会话提取（设计 §5.3）：会话结束（空闲）→ LLM 结构化抽取 → 待确认队列（零直写）。
 *
 * 铁律（附录 A，来自 memgas issue #1 的教训）：
 *   - 结构化输出的 LLM 调用**必须显式声明推理档位**（默认 minimal；off/none 在本机网关会返回空正文），绝不继承宿主默认；
 *   - 预算必须充足且可配（默认 8000），失败保留原始输出前缀；
 *   - 失败计数与最近原因必须可见（写进 meta，`mem_status` 展示）；
 *   - 连续失败 `degradeAfterFailures` 次后降级为"只记录不抽取"，不再白烧 token。
 *
 * 幂等：按会话游标（`sessions.ingest_cursor`）断点续做，同一区间绝不重复提取。
 */
import { sha1 } from './paths.js'
import { extractEntities } from './entities.js'

export const EXTRACT_DEFAULTS = {
  enabled: true,
  manual: true,
  auto: true,
  idleMinutes: 3,
  minTurns: 2,
  maxWaitMinutes: 30,
  onDispose: true,
  onCompaction: true,
  catchUp: true,
  maxItemsPerRun: 8,
  requireConfirm: true,
  maxTranscriptChars: 12000,
  distill: {
    // 网关只认 {minimal,low,medium,high,xhigh,max}；off/none 会**静默返回空正文**（实测）
    reasoningEffort: 'minimal',
    maxTokens: 8000,
    failVisible: true,
    degradeAfterFailures: 3,
  },
  tracks: ['user', 'memory', 'key', 'project', 'daily'],
}

export const TRACK_GUIDE = `轨道定义（必须严格按此判定）：
- user：用户本人是谁、偏好、沟通方式、习惯（跨项目）
- memory：跨项目的环境事实、工具、惯例、规则（所有会话都适用）
- key：当前项目的长期约定、决策、架构、踩坑（项目级长期）
- project：当前项目的进展与过程记录（做完什么、怎么做的）
- daily：今天做了什么（按天记录）

判断原则：能跨项目复用 → memory；只对当前项目长期有效 → key；过程性记录 → project/daily；
关于用户本人的 → user。宁可选 project，也不要把过程性内容塞进 key。`

export const EXTRACT_SYSTEM = `你是记忆提取器。从对话里提取"值得跨会话长期保留"的内容，输出严格 JSON。

${TRACK_GUIDE}

只提取这些类型：用户偏好、环境事实、工具用法、项目约定、决策、踩坑根因、可复用的做法。
**不要提取**：一次性的中间状态、密钥/token/密码、模型的推理过程、工具的长原始输出、代码细节的逐行复述。
**同时**判断本轮是否沉淀出了"可复用的工作方法"——即值得写成技能（SKILL.md）的流程/协议/检查清单：
- 只在**方法本身可复用**时建议（如"某类 bug 的排查步骤""某项目的发布核对清单"），不要建议一次性任务；
- 技能正文写成可执行步骤（命令、判据、验证方式），不要写空泛原则；
- 没有就省略 skills 字段，**不要硬凑**。

如果本轮没有任何值得长期保留的内容，返回 {"items": []}。

输出格式（严格 JSON，不要 markdown 代码块，不要解释）：
{"items":[{"content":"一条独立可读的记忆（中文，含关键标识符/路径/组件名原样）","track":"user|memory|key|project|daily","kind":"rule|preference|fact|decision|pitfall|env|progress","confidence":0.0-1.0,"evidence":"来自用户还是助手 + 关键原话片段","aliases":["换个说法时可能用到的词"],"entities":["路径/组件名/命令/bug号"]}],"skills":[{"name":"kebab-case-技能名","description":"一句话说明何时使用","body":"## 步骤\n1. …\n## 验证\n…","reason":"为什么值得沉淀"}]}

要求：
1. content 必须自包含（脱离对话也看得懂），一条只讲一件事，≤300 字；
2. 不确定的内容 confidence 给低分（助手推断 ≤0.6，用户明说可 0.9+）；
3. 保留原文语言与标识符原样，不要翻译、不要改写路径与组件名。`

/** 构造提取请求（消息数组）。 */
export function buildExtractRequest({ transcript, maxItems = 8, tracks = EXTRACT_DEFAULTS.tracks }) {
  const prompt = [
    `可选轨道：${tracks.join(' / ')}`,
    `单次最多输出 ${maxItems} 条；宁少勿滥。`,
    '',
    '对话转录（从旧到新）：',
    transcript,
  ].join('\n')
  return {
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  }
}

/** 从模型输出里抠出第一个平衡的 JSON 对象（容忍 markdown 围栏与前后废话）。 */
export function extractJson(raw) {
  let text = String(raw ?? '')
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence) text = fence[1]
  const start = text.search(/[{[]/)
  if (start === -1) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        const slice = text.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const KINDS = new Set(['rule', 'preference', 'fact', 'decision', 'pitfall', 'env', 'progress'])

/** 校验并规范化模型输出（坏条目丢弃，不整批拒绝）。 */
export function parseExtraction(raw, { tracks = EXTRACT_DEFAULTS.tracks, maxItems = 8 } = {}) {
  const json = extractJson(raw)
  if (!json) return { ok: false, reason: 'no JSON object in model output', rawPrefix: String(raw ?? '').slice(0, 500), items: [], skills: [] }
  const list = Array.isArray(json) ? json : Array.isArray(json.items) ? json.items : []
  if (!Array.isArray(list)) return { ok: false, reason: 'items 不是数组', rawPrefix: String(raw ?? '').slice(0, 500), items: [], skills: [] }
  const items = []
  const skills = []
  const seenSkill = new Set()
  const rawSkills = Array.isArray(json?.skills) ? json.skills : []
  for (const cand of rawSkills.slice(0, 3)) {
    if (!cand || typeof cand !== 'object') continue
    const name = String(cand.name ?? '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name) || seenSkill.has(name)) continue
    const body = String(cand.body ?? '').trim()
    if (body.length < 30) continue // 技能正文必须成篇（几步可执行步骤），拒绝一句话占位
    seenSkill.add(name)
    skills.push({ name, description: String(cand.description ?? '').trim().slice(0, 200), body: body.slice(0, 6000), reason: String(cand.reason ?? '').trim().slice(0, 300) })
  }
  const seen = new Set()
  for (const entry of list.slice(0, maxItems * 2)) {
    if (!entry || typeof entry !== 'object') continue
    const content = String(entry.content ?? '').trim()
    if (content.length < 4) continue
    const track = tracks.includes(entry.track) ? entry.track : 'project'
    const kind = KINDS.has(entry.kind) ? entry.kind : track === 'daily' || track === 'project' ? 'progress' : 'fact'
    const key = sha1(`${track}|${content}`)
    if (seen.has(key)) continue
    seen.add(key)
    const confidence = Number(entry.confidence)
    items.push({
      content: content.slice(0, 2000),
      track,
      kind,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
      evidence: String(entry.evidence ?? '').slice(0, 300),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.slice(0, 8).map(String) : [],
      entities: Array.isArray(entry.entities) ? entry.entities.slice(0, 16).map(String) : extractEntities(content),
    })
    if (items.length >= maxItems) break
  }
  return { ok: true, items, skills, rawPrefix: null }
}

/** 从会话读模型路由（provider/model）：提取复用会话自己的路由，不额外要求用户配 key。 */
export function routeOf(session) {
  try {
    const header = session?.requestHeader?.()
    const config = header?.config
    if (config?.provider && config?.model) return { provider: config.provider, model: config.model }
  } catch {
    /* 忽略 */
  }
  return null
}

/**
 * 调 LLM 做抽取。硬参数：显式 reasoningEffort + 充足 maxTokens；
 * 若该模型不支持所请求的档位，退一步不带档位重试并记录降级原因。
 */
export async function callExtractLlm({ llm, route, request, config = EXTRACT_DEFAULTS, signal = null, log = () => {} }) {
  const cfg = { ...EXTRACT_DEFAULTS.distill, ...(config.distill ?? {}) }
  const attempt = async (withEffort) => {
    const options = {
      provider: route.provider,
      model: route.model,
      system: request.system,
      temperature: 0,
      messages: request.messages,
      maxTokens: cfg.maxTokens,
      ...(withEffort && cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
      ...(signal ? { signal } : {}),
    }
    const stream = llm.stream(options)
    let text = ''
    for await (const record of stream) {
      if (record?.type === 'text-delta' && typeof record.text === 'string') text += record.text
    }
    return text
  }
  const tryOnce = async (withEffort) => {
    try {
      return { text: await attempt(withEffort) }
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }
  const first = await tryOnce(true)
  if (!first.error && first.text.trim() !== '') {
    return { ok: true, text: first.text, effort: cfg.reasoningEffort, degraded: null }
  }
  // 两条自愈路径：① 报"不支持该档位"；② 更隐蔽的一种——**档位不被网关认可时静默返回空正文**
  // （本机实测 off/none 只回 finish、无 text/reasoning）。两种都退回"不带档位"重试一次。
  const reason = first.error ? `不支持档位 ${cfg.reasoningEffort}（${first.error}）` : `档位 ${cfg.reasoningEffort} 下正文为空`
  log(`提取调用需退回默认档位（${reason}）`)
  const retry = await tryOnce(false)
  if (!retry.error && retry.text.trim() !== '') {
    return { ok: true, text: retry.text, effort: null, degraded: `${reason}，已退回默认档位` }
  }
  if (retry.error) return { ok: false, error: retry.error, effort: null, degraded: null }
  return { ok: false, error: '模型返回空正文（档位与默认档位均为空）', effort: null, degraded: null }
}

/** 计失败与降级状态（写进 meta，`mem_status` 可见）。 */
export function recordExtractFailure(store, { reason, rawPrefix = null, config = EXTRACT_DEFAULTS }) {
  const cfg = { ...EXTRACT_DEFAULTS.distill, ...(config.distill ?? {}) }
  const failures = Number(store.getMeta('extract_failures', '0')) + 1
  store.setMeta('extract_failures', failures)
  store.setMeta('extract_last_failure', reason)
  store.setMeta('extract_last_failure_at', new Date().toISOString())
  store.setMeta('extract_last_raw_prefix', String(rawPrefix ?? '').trim() ? String(rawPrefix).slice(0, 500) : '(空输出)')
  if (cfg.degradeAfterFailures > 0 && failures >= cfg.degradeAfterFailures) {
    store.setMeta('extract_degraded', 'true')
  }
  return { failures, degraded: store.getMeta('extract_degraded', 'false') === 'true' }
}

export function recordExtractSuccess(store, { items, model, effort }) {
  store.setMeta('extract_failures', 0)
  store.setMeta('extract_degraded', 'false')
  store.setMeta('extract_last_success_at', new Date().toISOString())
  store.setMeta('extract_last_model', `${model}${effort ? `@${effort}` : ''}`)
  const total = Number(store.getMeta('extract_items_total', '0')) + items
  store.setMeta('extract_items_total', total)
}

/**
 * 抽取一条会话（活体转录或落盘日志由调用方提供转录）。
 * @returns {{ ok: boolean, queued?: number, skipped?: number, reason?: string }}
 */
export async function extractSession({ store, transcript, llm, route, sessionId = null, cwd = null, config = EXTRACT_DEFAULTS, signal = null, log = () => {}, enqueue = null, enqueueSkill = null }) {
  const cfg = { ...EXTRACT_DEFAULTS, ...config, distill: { ...EXTRACT_DEFAULTS.distill, ...(config.distill ?? {}) } }
  if (store.getMeta('extract_degraded', 'false') === 'true') {
    return { ok: false, reason: '已降级（连续抽取失败），跳过本次' }
  }
  if (!llm || !route) return { ok: false, reason: '没有可用的模型路由' }
  const request = buildExtractRequest({ transcript, maxItems: cfg.maxItemsPerRun, tracks: cfg.tracks })
  const res = await callExtractLlm({ llm, route, request, config: cfg, signal, log })
  if (!res.ok) {
    const state = recordExtractFailure(store, { reason: res.error, config: cfg })
    return { ok: false, reason: `模型调用失败：${res.error}`, failures: state.failures, degraded: state.degraded }
  }
  const parsed = parseExtraction(res.text, { tracks: cfg.tracks, maxItems: cfg.maxItemsPerRun })
  if (!parsed.ok) {
    const state = recordExtractFailure(store, { reason: parsed.reason, rawPrefix: parsed.rawPrefix, config: cfg })
    return { ok: false, reason: parsed.reason, failures: state.failures, degraded: state.degraded }
  }

  // 一律进待确认队列（零直写）：enqueue 由调用方注入 writer.writeMemory（force=false）。
  let queued = 0
  let skipped = 0
  const results = []
  for (const item of parsed.items) {
    const outcome = enqueue
      ? enqueue(item)
      : { status: 'queued' }
    results.push({ item, outcome })
    if (outcome?.status === 'queued' || outcome?.status === 'queued-duplicate') queued += 1
    else skipped += 1
  }
  // 技能候选（自进化审查）：同样零直写，只进待确认队列，人工采纳后才写入技能库
  let skillQueued = 0
  for (const cand of parsed.skills ?? []) {
    const outcome = enqueueSkill
      ? enqueueSkill(cand)
      : { status: 'queued' }
    if (outcome?.status === 'queued' || outcome?.status === 'queued-duplicate') skillQueued += 1
  }
  recordExtractSuccess(store, { items: parsed.items.length, model: route.model, effort: res.effort })
  return { ok: true, queued, skipped, skillQueued, items: parsed.items, skills: parsed.skills ?? [], results, degraded: res.degraded, model: route.model, effort: res.effort }
}

/**
 * 判断哪些会话该跑提取（设计 §5.3 触发矩阵的"空闲"与"长会话兜底"两支）。
 *
 * ⚠️ max-wait 的基准**不能**用 `sessions.last_seen`：它是每次活动都刷新的"最近活动时间"，
 * 于是一个一直在用的会话永远够不到 30 分钟 → 「长会话兜底」形同虚设（实测：跑了 100 分钟
 * 的会话 turns_processed=0、一次都没被自动提取，用户看到的就是"本会话生成的待确认写不进来"）。
 * 正确基准：上次提取时间（DB）> 本进程首次观察到该会话的时间（`state.firstSeen`）> last_seen。
 * @param {{ store: any, live: Map<string,{lastSeen:number, seq:number, turns:number, firstSeen?:number}>, config?: object, now?: number }} deps
 */
export function planAutoExtract({ store, live = new Map(), config = EXTRACT_DEFAULTS, now = Date.now() }) {
  const cfg = { ...EXTRACT_DEFAULTS, ...config }
  if (cfg.auto === false) return []
  const due = []
  for (const [sessionId, state] of live.entries()) {
    const row = store.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
    const cursor = row?.ingest_cursor ?? 0
    const newTurns = Math.max(0, (state.turns ?? 0) - (row?.turns_processed ?? 0))
    if (state.seq <= cursor) continue
    const idleMs = now - (state.lastSeen ?? 0)
    // 从未提取过时以"首次观察到该会话的时间"为基准（老状态没有 firstSeen 才退回 last_seen）
    const baseline = row?.last_extract_at ?? state.firstSeen ?? row?.last_seen ?? now
    const waitedMs = now - baseline
    const byIdle = idleMs >= cfg.idleMinutes * 60000
    const byMaxWait = waitedMs >= cfg.maxWaitMinutes * 60000 && newTurns >= cfg.minTurns
    if (!byIdle && !byMaxWait) continue
    if (newTurns < cfg.minTurns) continue
    due.push({ sessionId, reason: byIdle ? 'idle' : 'max-wait', cursor, seq: state.seq, newTurns })
  }
  return due
}

/** 记录一次提取完成（游标前移，供断点续做）。 */
export function markExtracted({ store, sessionId, cursor, scope = null, title = null, turns = null }) {
  const row = store.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
  const now = Date.now()
  if (row) {
    store.db
      .prepare('UPDATE sessions SET ingest_cursor = ?, scope = COALESCE(?, scope), title = COALESCE(?, title), last_extract_at = ?, turns_processed = COALESCE(?, turns_processed) WHERE id = ?')
      .run(cursor, scope, title, now, turns, sessionId)
  } else {
    store.db
      .prepare('INSERT INTO sessions (id, scope, ingest_cursor, last_seen, title, last_extract_at, turns_processed) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, scope, cursor, now, title, now, turns ?? 0)
  }
}

export function noteSessionActivity({ store, sessionId, scope = null, seq = 0, turns = 0 }) {
  const row = store.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
  const now = Date.now()
  if (row) {
    store.db
      .prepare('UPDATE sessions SET last_seen = ?, scope = COALESCE(?, scope) WHERE id = ?')
      .run(now, scope, sessionId)
  } else {
    store.db
      .prepare('INSERT INTO sessions (id, scope, ingest_cursor, last_seen, title) VALUES (?, ?, 0, ?, NULL)')
      .run(sessionId, scope, now)
  }
}
