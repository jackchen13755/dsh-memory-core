/**
 * 召回引擎（设计 §6）：五通道并行 → RRF 融合 → 乘性加权 → 基线保底 → 证据判定 → 归因。
 *
 * 通道：
 *   C1 lexical     SQLite FTS5（bigram + 标识符），bm25 排序
 *   C2 sparse      JS BM25 + 元数据加权（实体归一化命中 / summary / 标签）
 *   C3 granularity 条目 / 当日 / 项目轨 / 抽象 四种粒度分别打分，熵路由分配权重
 *   C4 graph       M5 接入（当前显式声明 disabled，带原因）
 *   C5 temporal    查询里的时间表达 → 时间窗口，窗口内按 bm25 选 + 分桶取代表
 *
 * 三条设计硬约束（§2）：
 *   可降级 —— 任一通道异常/超时都跳过，其余照常融合；全失败返回空 + 原因
 *   不劣化 —— 最终 top-k 至少一半席位留给 C1+C2 的融合结果
 *   可归因 —— 每条命中都能说清"哪条通道、什么排名、为什么"
 *
 * 加权层（对标 hindsight Stage3，2026-10-14）只作用于**总榜排序**：
 * score' = rrf × recencyBoost × importanceBoost × usageBoost × proofBoost，
 * 每项 boost = 1 + α(signal − 0.5)。**保底席位仍按纯 RRF 的 C1+C2 排序取** ——
 * 次要信号不得盖过词面相关性（见 search() 里的 baseline / overall 两段）。
 */
import { ftsQuery, tokenize } from './tokens.js'
import { entityMatches, extractEntities, normalizeEntity } from './entities.js'

export const DEFAULT_CONFIG = {
  k: 8,
  baselineFloor: 0.5,
  budgetMs: 300,
  rrfK: 60,
  coldStartUnits: 50,
  perChannel: 50,
  maxCorpusDocs: 20000,
  entropyUniformRatio: 1.15,
  channels: {
    lexical: { enabled: true, weight: 1 },
    sparse: { enabled: true, weight: 1 },
    granularity: { enabled: true, weight: 0.8, router: 'entropy' },
    graph: { enabled: true, weight: 0.6, damping: 0.85, iterations: 12, seedCount: 8, minEdges: 20 },
    temporal: { enabled: true, weight: 1 },
  },
  /**
   * 乘性加权层（对标 hindsight Stage3）。四个信号各自出一个 boost，相乘后乘在 RRF 上：
   *
   *   boost = 1 + α × (signal − 0.5)        signal ∈ [0,1]，0.5 = 中性
   *
   * 乘性而非加性：次要信号只能**按比例**微调相关性排序，不允许盖过词面证据。
   * α 默认取 hindsight 的一组保守值（recency/importance 0.2、proof 0.1）；
   * usage（units.access_count，本机独有）与它们并列且同样可配。
   * enabled=false 或全部 α=0 时因子恒为 1 —— 与改造前逐位等价（见单测对照）。
   */
  boosts: {
    enabled: true,
    recencyAlpha: 0.2,
    importanceAlpha: 0.2,
    usageAlpha: 0.2,
    proofAlpha: 0.1,
    recencySpanDays: 365,
    usageReference: 1000, // usage 信号的饱和参考点（ln 归一化）
    now: null, // 覆盖"当前时刻"（回放 / 单测确定性用）；null = Date.now()
  },
  /**
   * ── 基线已知回退清单（2026-10-14 · t21 备案，纯注释、零行为改动）──────────────
   *
   * 【口径】比较两棵树 / 两个 arm 时，「差异」必须同时报三档，否则口径自相矛盾：
   *   ① 命中标志（labels 期望的 id 是否落在 top-k）—— **只有它影响 eval 命中率**；
   *   ② 融合 top-k 的 id 集合；
   *   ③ 融合 top-k 的 id 序列（含顺序）。
   * ②③ 是排序层；「集合同、仅顺序不同」属 ③ 的差异，**不影响命中数**。
   *
   * 【实测（同一份快照字节、24 条标注查询；A=当前默认 / B=HEAD 纯树 / C=当前+boosts.enabled=false）】
   *   as-is 快照（1003 units / 188 archived）：A 4/24、B 3/24、C 3/24；
   *     A vs B：命中标志差 1（+1『抓内网的 wiki 页面该用哪个工具』）、集合不同 17、仅顺序 7；
   *     C vs B：三档全 0 —— 24/24 完全一致。
   *   archive-restored 快照（把 archived 全改 active，997 active）：A 19/24、B 20/24、C 20/24；
   *     A vs B：命中标志差 3（+1『多选标签的文案被截断还压到关闭图标上』；−2『github release
   *       的安装包下载不下来』(期望 ec841b56) 与『本地开发怎么跳过登录鉴权』）、集合不同 19、仅顺序 5；
   *     C vs B：三档全 0 —— 24/24 完全一致。
   *
   * 【差异源 = 本加权层（boosts）】两快照上 C（关掉加权）与 HEAD 逐条一致；逐通道隔离比对
   * lexical / sparse / granularity 的 id 序列、id 集合、分数**全为 0/24 差异**；granularity 的
   * 代码相对 HEAD 逐行未改，sparse 的唯一改动是实体块，而 extractEntities() 在这 24 条查询上
   * 恒为 []（0/24 非空）⇒ 该块不执行。所以 net −1（archive-restored 视图）与 net +1（as-is 视图）
   * 都记在本加权层名下，**不记在 sparse/granularity 名下**（那种归因与上述隔离实测矛盾）。
   * 行级根因（哪个 boost 把哪个 id 挤出 top-5）尚未归因，另派任务处理，此处不下结论。
   *
   * 【已知盲区：实体归一化在本标注集上不可测】extractEntities() 只认反引号/带分隔符的片段，
   * 而 24 条查询全是裸单词（s360 / H5 / antd / figma / wiki…）⇒ 抽取恒为 []（0/24），
   * 这批查询没走实体通道 —— **零敏感 ≠ 无收益**。能力级收益可在隔离用例上复核：全角折叠、
   * 反斜杠↔斜杠统一、空白折叠三处 HEAD 漏而 current 命中，且
   * normalizeEntity('@/components/FooterButton')
   *   === normalizeEntity('＠／ｃｏｍｐｏｎｅｎｔｓ／ｆｏｏｔｅｒｂｕｔｔｏｎ')。
   * ──────────────────────────────────────────────────────────────────────────────
   */
  evidence: {
    topRank: 3, // 通道前 N 名视为强证据
    bm25Ratio: 0.6, // 相对本查询最高分的比例
    requireTwoChannel: false,
  },
}

const BM25_K1 = 1.2
const BM25_B = 0.75

function mergeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    channels: { ...DEFAULT_CONFIG.channels, ...(config.channels ?? {}) },
    boosts: { ...DEFAULT_CONFIG.boosts, ...(config.boosts ?? {}) },
    evidence: { ...DEFAULT_CONFIG.evidence, ...(config.evidence ?? {}) },
  }
}

const num = (x, fallback = 0) => (Number.isFinite(Number(x)) ? Number(x) : fallback)
const clampRange = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

/**
 * 时间信号：基准时间取 occurred_at ?? created_at（事件时间优先，未知才回落写入时间）。
 * signal = clamp(1 − daysSince / recencySpanDays, 0.1, 1)；时间不可知时取最保守的 0.1。
 */
export function signalRecency(ts, now = Date.now(), spanDays = 365) {
  const t = Number(ts)
  const at = num(now, Date.now())
  if (!Number.isFinite(t) || t <= 0) return 0.1
  const span = num(spanDays, 365) > 0 ? num(spanDays, 365) : 365
  const days = Math.max(0, (at - t) / 86400000)
  return clampRange(1 - days / span, 0.1, 1)
}

/** 重要性信号：units.importance 本身已是 0..1、0.5 中性 —— 天然契合该公式。 */
export function signalImportance(importance) {
  const v = Number(importance)
  return Number.isFinite(v) ? clampRange(v, 0, 1) : 0.5
}

/**
 * 使用信号（对标 hindsight proof_count 的"证据强度"思路，本机独有）：
 * units.access_count = 该条被真实取回过的次数。ln 饱和，0 次即 0（无使用证据）。
 */
export function signalUsage(accessCount, reference = 1000) {
  const n = Number(accessCount)
  if (!Number.isFinite(n) || n <= 0) return 0
  const ref = num(reference, 1000) > 1 ? num(reference, 1000) : 1000
  return clampRange(Math.log1p(n) / Math.log1p(ref), 0, 1)
}

/**
 * 证据信号：仅 kind='abstract' 用 clamp(0.5 + ln(proofCount)/10, 0, 1)，
 * proofCount = edges 表里 kind='derivedFrom' 指向该条的入边数（lib/evolution.js 在写）。
 * 非 abstract 恒 0.5（中性）：普通条目没有"派生证据"这回事，不该被这个信号奖罚。
 * proofCount = 0 时 ln(0) = −∞ → clamp 到 0（未证实的抽象层条目排在后面）。
 */
export function signalProof(kind, proofCount) {
  if (kind !== 'abstract') return 0.5
  const n = Number(proofCount)
  const ln = Number.isFinite(n) && n > 0 ? Math.log(n) : Number.NEGATIVE_INFINITY
  return clampRange(0.5 + ln / 10, 0, 1)
}

/** 构造一个合法日期的本地 0 点时间戳；月份/日越界（如 2026-13-45）返回 null。 */
function localYmd(y, mo, d) {
  if (!(y >= 1970 && y <= 9999) || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, mo - 1, d, 0, 0, 0, 0)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt.getTime()
}

/** 本地日 0 点。 */
const startOfDay = (ts) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 按**日历日**加减（跨月/跨年/夏令时都正确，不用 86400000 硬加）。 */
const addDays = (ts, n) => {
  const d = new Date(ts)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

const addMonths = (ts, n) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  return d.getTime()
}

/** 周一为一周之始（中文语境）。 */
const startOfWeek = (ts) => {
  const base = startOfDay(ts)
  const dow = (new Date(base).getDay() + 6) % 7
  return addDays(base, -dow)
}

const startOfMonth = (ts) => addMonths(ts, 0)

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 解析 query 里的时间表达 → 半开区间 [from, to)（本地时区）。
 *
 * 认得的写法（按**特异性**从前到后匹配，先命中先返回）：
 *   YYYY-MM-DD / YYYY/M/D       → 那一天
 *   YYYY-MM（含 YYYY/MM）        → 那一月
 *   今天 / 昨天 / 前天            → 那一天
 *   最近N天 / 近N天 / N天内 / N天前 → N 天窗口 / N 天前那一天
 *   本周 / 上周、本月 / 上个月      → 周一为一周之始；自然月
 *   今年 / 去年                   → 自然年
 *
 * 解析不出返回 null —— 调用方按 channelGraph 的 skippedReason 风格跳过该通道，
 * **绝不猜**（猜错窗口比不召回更糟）。
 *
 * `now` 的缺省语义：**null / 缺省 / 非有限数一律回落 Date.now()**。
 * 不能写成 `num(now, Date.now())` —— `Number(null) === 0` 是有限数，会把"当前时刻"
 * 静默当成 1970-01-01（窗口整段落到 epoch 附近，时序通道永远返回空）。
 */
export function parseTimeWindow(query, { now = null } = {}) {
  const s = String(query ?? '')
  const at = now == null || !Number.isFinite(Number(now)) ? Date.now() : Number(now)

  // ① 显式日期：YYYY-MM-DD / YYYY/M/D
  const ymdMatch = s.match(/(?:^|[^\d])(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?![\d])/)
  if (ymdMatch) {
    const from = localYmd(Number(ymdMatch[1]), Number(ymdMatch[2]), Number(ymdMatch[3]))
    if (from !== null) {
      return { from, to: addDays(from, 1), label: `${ymdMatch[1]}-${pad2(Number(ymdMatch[2]))}-${pad2(Number(ymdMatch[3]))}`, kind: 'day' }
    }
  }

  // ② 显式年月：YYYY-MM（后面不能再跟 -DD，否则上面已返回）
  const ymMatch = s.match(/(?:^|[^\d])(\d{4})[-/](\d{1,2})(?![\d/-])/)
  if (ymMatch) {
    const from = localYmd(Number(ymMatch[1]), Number(ymMatch[2]), 1)
    if (from !== null) {
      return { from, to: addMonths(from, 1), label: `${ymMatch[1]}-${pad2(Number(ymMatch[2]))}`, kind: 'month' }
    }
  }

  // ③ 相对日
  const today = startOfDay(at)
  if (/今天|今日/.test(s)) return { from: today, to: addDays(today, 1), label: '今天', kind: 'day' }
  if (/昨天|昨日/.test(s)) return { from: addDays(today, -1), to: today, label: '昨天', kind: 'day' }
  if (/前天/.test(s)) return { from: addDays(today, -2), to: addDays(today, -1), label: '前天', kind: 'day' }

  // ④ N 天窗口 / N 天前（"最近3天""近 7 天""3天内""3天前"）
  const lastN = s.match(/(?:最近|近|过去)\s*(\d{1,4})\s*(?:天|日)/) ?? s.match(/(\d{1,4})\s*(?:天|日)内/)
  if (lastN) {
    const n = clampRange(Math.floor(Number(lastN[1])) || 1, 1, 3650)
    return { from: addDays(today, -(n - 1)), to: at + 1, label: `最近${n}天`, kind: 'range' }
  }
  const daysAgo = s.match(/(\d{1,4})\s*(?:天|日)前/)
  if (daysAgo) {
    const n = clampRange(Math.floor(Number(daysAgo[1])) || 0, 0, 36500)
    const from = addDays(today, -n)
    return { from, to: addDays(from, 1), label: `${n}天前`, kind: 'day' }
  }

  // ⑤ 周 / 月 / 年
  if (/本周|这周|这星期|本星期/.test(s)) {
    const from = startOfWeek(at)
    return { from, to: addDays(from, 7), label: '本周', kind: 'week' }
  }
  if (/上周|上个?星期/.test(s)) {
    const from = addDays(startOfWeek(at), -7)
    return { from, to: addDays(from, 7), label: '上周', kind: 'week' }
  }
  if (/本月|这个月|当月|本月份/.test(s)) {
    const from = startOfMonth(at)
    return { from, to: addMonths(from, 1), label: '本月', kind: 'month' }
  }
  if (/上月|上个月|上月份/.test(s)) {
    const from = addMonths(startOfMonth(at), -1)
    return { from, to: addMonths(from, 1), label: '上个月', kind: 'month' }
  }
  if (/今年|本年度|本年/.test(s)) {
    const from = localYmd(new Date(at).getFullYear(), 1, 1)
    return { from, to: localYmd(new Date(at).getFullYear() + 1, 1, 1), label: '今年', kind: 'year' }
  }
  if (/去年|上一年/.test(s)) {
    const from = localYmd(new Date(at).getFullYear() - 1, 1, 1)
    return { from, to: localYmd(new Date(at).getFullYear(), 1, 1), label: '去年', kind: 'year' }
  }

  return null
}

/** 内存语料索引：token 倒排 + 元数据 + 多粒度聚合。由 store 的版本戳惰性重建。 */
export class Corpus {
  constructor(store, { maxDocs = DEFAULT_CONFIG.maxCorpusDocs } = {}) {
    this.store = store
    this.maxDocs = maxDocs
    this.stamp = null
    this.docs = new Map()
    this.df = new Map()
    this.avgLen = 1
    this.aggregates = { day: new Map(), trackScope: new Map() }
    this.truncated = false
  }

  ensure() {
    /**
     * 版本戳必须覆盖"语料内容会不会变"，而不只是"行数变没变"：
     * 演化（reinforce/decay/revive）与取回计数（tools.js）都直接 UPDATE
     * importance / access_count / status，**不 bump updated_at** —— 只看 t 会拿到陈旧语料，
     * 加权层就会按旧的 importance/access_count 打分。故加上 active 行数与两个分量和。
     *
     * **代价与节流（t6 备案，当前不实现节流）**：戳一变就 build() 全量重建语料。
     * mem_get 每次取回都 bump access_count（tools.js:159 只改 access_count / last_accessed，
     * 同样不 bump updated_at）→ 戳失效 → **每次取回都会触发一次全量重建**；
     * 真实库 998 条实测约 50ms/次（本机）。
     *
     * 何时该引入节流：单次重建成本 × 取回频率开始盖过检索预算（budgetMs 300ms 的同一数量级），
     * 即**条目量上万**或 mem_get 变成高频路径时。届时的做法（择一，别提前做）：
     *   ① 按行过期：只重建版本号变过的条目（需要 units 上有可比的 version/rowid 水位）；
     *   ② 把 access_count 从戳里摘出来做**增量累加**（重建时按 id 回读最新计数），
     *      让"取回"不再让整个语料失效 —— 但要注意权重信号会短暂陈旧，需接受这一点。
     */
    const row = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(MAX(rowid), 0) AS m,
                COALESCE(MAX(updated_at), 0) AS t,
                COALESCE(SUM(access_count), 0) AS a,
                COALESCE(SUM(CAST(importance * 1000 AS INTEGER)), 0) AS i,
                COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS s,
                COALESCE(SUM(occurred_at), 0) AS o
           FROM units`,
      )
      .get()
    const proof = this.derivedFromTotal()
    /**
     * occurred_at **必须**进戳 —— 这条当初是"有条件的豁免"，条件现在已经不成立了：
     * 当初的理由是"本库不存在改某条事件时间的路径"，而 t12 给 `mem_update` 打通了改时间
     * （tools.js 的 `UPDATE units SET occurred_at`）、同步导入（sync.js）也会就地改它。
     * 其中 mem_update 会顺带 bump updated_at（戳跟着动，安全），但**同步导入不会**：远端行的
     * updated_at 常常不是本地的 MAX(updated_at)，戳不动 → 语料保留旧的 occurred_at →
     * recency 打分（doc.occurredAt）与时序通道的归窗（直接读 DB）用两个不同的值。
     * 所以这里按当初注释自己写下的规定，把发生时间之和并进戳。
     */
    const stamp = `${row.n}:${row.m}:${row.t}:${row.a}:${row.i}:${row.s}:${row.o}:${proof}`
    if (stamp === this.stamp) return this
    this.stamp = stamp
    this.build()
    return this
  }

  /**
   * derivedFrom 入边总数：proof 信号的分母（写入即失效语料，见 ensure 的注释）。
   *
   * 取舍（t6 备案）：戳里只记**总数**，不记集合指纹 —— 依据是**边只增不减**
   * （evolution 只 INSERT OR REPLACE derivedFrom 边，全库无 DELETE/DROP edges 的路径；
   * 若将来出现删边，总数可能不变，此时戳就漏了，必须换成指纹）。
   * 计数**不过滤 status**：抽象条被归档后 proofCount 仍计入（保守方向 —— 归档条目本来
   * 也不在语料里，多算不会造成误召回）；反过来若要"只算 active 源的证据"就得 JOIN units，
   * 成本与语义都更重，当前不值得。
   */
  derivedFromTotal() {
    const row = this.store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE kind = 'derivedFrom'").get()
    return Number(row?.n ?? 0)
  }

  build() {
    this.docs.clear()
    this.df.clear()
    this.aggregates.day.clear()
    this.aggregates.trackScope.clear()
    const rows = this.store.db
      .prepare(
        `SELECT id, track, scope, kind, day, meta, tokens, content, created_at, origin,
                importance, access_count, last_accessed, pinned, occurred_at
           FROM units WHERE status = 'active' ORDER BY rowid LIMIT ?`,
      )
      .all(this.maxDocs + 1)
    // 证据数（proof signal）：每条 abstract 被多少条 derivedFrom 边指向。
    // 同样**不过滤 status**（抽象条归档后仍计入；归档条目不在语料里，多算不会误召回），
    // 且依赖"边只增不减"——与 derivedFromTotal() 的取舍见该函数注释。
    const proofCounts = new Map()
    for (const r of this.store.db
      .prepare("SELECT to_id AS id, COUNT(*) AS n FROM edges WHERE kind = 'derivedFrom' GROUP BY to_id")
      .all()) {
      proofCounts.set(r.id, Number(r.n))
    }
    this.truncated = rows.length > this.maxDocs
    let totalLen = 0
    for (const row of rows.slice(0, this.maxDocs)) {
      let meta = {}
      try {
        meta = row.meta ? JSON.parse(row.meta) : {}
      } catch {
        meta = {}
      }
      const tokens = row.tokens ? row.tokens.split(' ').filter(Boolean) : tokenize(row.content)
      const tf = new Map()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      const doc = {
        id: row.id,
        track: row.track,
        scope: row.scope,
        kind: row.kind,
        day: row.day,
        createdAt: row.created_at,
        len: tokens.length,
        tf,
        content: row.content,
        ents: new Set((meta.ent ?? []).map((e) => String(e).toLowerCase())),
        /**
         * 归一化实体键，**在 rebuild 时算一次**（M2：C2 的实体匹配是
         * 「每文档 × 每查询实体」的嵌套循环，旧写法在最内层反复跑 normalizeEntity，
         * 实测把 channelSparse 拖到 +207%、整条 search +48%）。
         * 与 `ents` 并存：`ents` 仍是原始键（别处按原样比较用），这里只是给热路径用的缓存；
         * 空串会被滤掉（空键参与 includes 判定会把一切都匹配上）。
         */
        entsNorm: (meta.ent ?? []).map((e) => normalizeEntity(String(e))).filter(Boolean),
        aliases: (meta.alias ?? []).map((a) => String(a)),
        tags: (meta.tags ?? []).map((t) => String(t)),
        summary: meta.summary ?? '',
        // 加权层信号：事件时间优先，未知才回落写入时间
        occurredAt: row.occurred_at ?? null,
        importance: Number(row.importance ?? 0.5),
        accessCount: Number(row.access_count ?? 0),
        lastAccessed: row.last_accessed ?? null,
        pinned: Number(row.pinned ?? 0),
        proofCount: proofCounts.get(row.id) ?? 0,
        /** 来源（prov 标记用，确定性事实：import / session:… / extract:… / evolve:… / tool …）。 */
        origin: row.origin ?? null,
        /** 被隔离（导入/同步补扫判 high）→ 不进自动注入，只能显式 mem_get/mem_search 取回（P0-2）。 */
        quarantined: meta.quarantined === true,
      }
      this.docs.set(doc.id, doc)
      totalLen += doc.len
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.addToAggregate('day', doc.day, doc)
      this.addToAggregate('trackScope', `${doc.track}|${doc.scope}`, doc)
    }
    this.avgLen = this.docs.size > 0 ? totalLen / this.docs.size : 1
  }

  addToAggregate(kind, key, doc) {
    if (!key) return
    const map = this.aggregates[kind]
    let agg = map.get(key)
    if (!agg) {
      agg = { key, tf: new Map(), len: 0, members: [] }
      map.set(key, agg)
    }
    for (const [t, n] of doc.tf) agg.tf.set(t, (agg.tf.get(t) ?? 0) + n)
    agg.len += doc.len
    agg.members.push(doc.id)
  }

  idf(token) {
    const n = this.docs.size
    const df = this.df.get(token) ?? 0
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  /** BM25：查询词条对某个 (tf, len) 打分。 */
  bm25(tf, len, terms) {
    let score = 0
    for (const term of terms) {
      const f = tf.get(term)
      if (!f) continue
      const norm = 1 - BM25_B + BM25_B * (len / this.avgLen)
      score += this.idf(term) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * norm))
    }
    return score
  }
}

function minMaxNormalize(map) {
  let min = Infinity
  let max = -Infinity
  for (const v of map.values()) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || max - min < 1e-9) {
    const out = new Map()
    for (const k of map.keys()) out.set(k, 0)
    return out
  }
  const out = new Map()
  for (const [k, v] of map) out.set(k, (v - min) / (max - min))
  return out
}

function entropyOf(dist) {
  let h = 0
  let sum = 0
  for (const v of dist.values()) sum += v
  if (sum <= 0) return 0
  for (const v of dist.values()) {
    const p = v / sum
    if (p > 0) h -= p * Math.log(p)
  }
  return h
}

export class Recall {
  constructor(store, config = {}) {
    this.store = store
    this.config = mergeConfig(config)
    this.corpus = new Corpus(store, { maxDocs: this.config.maxCorpusDocs })
  }

  reconfigure(config = {}) {
    this.config = mergeConfig({ ...this.config, ...config })
  }

  scopeClause(scopes) {
    if (!scopes || scopes === 'all') return { sql: '', args: [] }
    const list = Array.isArray(scopes) ? scopes.filter(Boolean) : [scopes]
    if (list.length === 0) return { sql: '', args: [] }
    return { sql: ` AND u.scope IN (${list.map(() => '?').join(',')})`, args: list }
  }

  /** C1：FTS5 词法通道。 */
  channelLexical(query, { scopes, limit }) {
    const match = ftsQuery(query)
    if (!match) return []
    const { sql, args } = this.scopeClause(scopes)
    const rows = this.store.db
      .prepare(
        `SELECT u.id, bm25(units_fts) AS score
           FROM units_fts JOIN units u ON u.rowid = units_fts.rowid
          WHERE units_fts MATCH ? AND u.status = 'active'${sql}
          ORDER BY score LIMIT ?`,
      )
      .all(match, ...args, limit)
    return rows.map((r, i) => ({ id: r.id, score: -Number(r.score), rank: i + 1 }))
  }

  /** C2：JS BM25 + 元数据加权（实体归一化命中 / 摘要 / 标签）。 */
  channelSparse(query, { scopes, limit }) {
    // query 归一化：`diag()` 会在没有查询词时调用本通道，直接对它调 `query.includes(...)` 会崩
    // （实测：mem_diag 无参调用 → Cannot read properties of undefined (reading 'includes')）
    query = String(query ?? '')
    const corpus = this.corpus.ensure()
    const terms = tokenize(query)
    /**
     * 实体匹配走 entities.js 的归一化键（大小写/空白/全角/分隔符差异不再漏配），
     * 加分数值语义不变：精确命中 +4、别名/部分包含 +1.5。
     *
     * 归一化只做**每查询一遍**（查询侧实体），文档侧用 build 时算好的 `doc.entsNorm`
     * 缓存 —— 旧写法在「每文档 × 每查询实体 × 每文档实体」三层里反复 normalizeEntity，
     * 是这条通道的主要开销（M2）。语义与 `entityMatches` 逐条对齐：
     *   ① 任一文档实体归一化后与查询实体**精确相等** → +4（哪怕先遇到的是包含关系）；
     *   ② 否则任一文档实体与查询实体**互相包含** → +1.5；
     *   ③ 空查询键 / 空文档键永不命中（避免空键把一切都匹配上）。
     */
    const queryEntities = extractEntities(query)
    const queryNorm = queryEntities.map((e) => normalizeEntity(e))
    const scopeSet = !scopes || scopes === 'all' ? null : new Set(Array.isArray(scopes) ? scopes : [scopes])
    const scored = []
    for (const doc of corpus.docs.values()) {
      if (scopeSet && !scopeSet.has(doc.scope)) continue
      let score = corpus.bm25(doc.tf, doc.len, terms)
      for (const q of queryNorm) {
        if (!q) continue
        let exact = false
        let partial = false
        for (const d of doc.entsNorm ?? []) {
          if (!d) continue
          if (d === q) {
            exact = true
            break
          }
          if (d.includes(q) || q.includes(d)) partial = true
        }
        if (exact) score += 4
        else if (partial) score += 1.5
      }
      if (doc.summary && terms.some((t) => doc.summary.includes(t))) score += 1.2
      for (const tag of doc.tags) if (query.includes(tag)) score += 1
      for (const alias of doc.aliases) if (alias && query.includes(alias)) score += 2
      if (score > 0) scored.push({ id: doc.id, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((r, i) => ({ id: r.id, score: r.score, rank: i + 1 }))
  }

  /**
   * C5：时序通道（对标 hindsight temporal）。
   *
   * 先解析查询里的时间窗口（parseTimeWindow），拿不到窗口就跳过并给原因。
   * 窗口内**按语义相关性（bm25）选，而不是按新近度** —— 时间是过滤条件，不是排序依据；
   * 再**分时间桶轮转取代表**（桶内按 bm25 排，桶间轮转），避免结果全挤在窗口里最密的那一段。
   * 时间字段统一 COALESCE(occurred_at, created_at)：事件时间优先，未知才回落写入时间。
   * 窗口是**半开区间 [from, to)**（与 parseTimeWindow 的文档一致）：右端点专指"下一段起点"，
   * 因此「今天」不会把次日 00:00:00.000 整点的条目也算进来（相邻窗口不会各自多含一条）。
   *
   * 与 graph 一样只进总榜，不占基线保底席位（见 search 里的 addList 位置）。
   * 注意：窗口条件用了 COALESCE 因而**走不了索引**（逐行扫 units）—— 万级以内的记忆库
   * 开销可忽略，且外层仍有 budgetMs 守卫；真要上更大规模时再补 GENERATED COLUMN 索引。
   */
  channelTemporal(query, { scopes, limit, now = null } = {}) {
    const cfg = this.config.boosts ?? {}
    // null / 缺省 / 非有限数 → 回落 boosts.now → 再回落 Date.now()。
    // 注意 Number(null) === 0 是有限数，写成 Number.isFinite(Number(now)) 会把"未指定 now"
    // 静默当成 epoch（窗口整体落到 1970），必须显式判 null。
    const atOpt = now ?? cfg.now
    const at = atOpt == null || !Number.isFinite(Number(atOpt)) ? Date.now() : Number(atOpt)
    const win = parseTimeWindow(query, { now: at })
    if (!win) return { list: [], reason: '未解析出时间窗口' }
    const terms = tokenize(query)
    if (terms.length === 0) return { list: [], reason: `时间窗口「${win.label}」内没有可用的查询词` }

    const corpus = this.corpus.ensure()
    const { sql, args } = this.scopeClause(scopes)
    const rows = this.store.db
      .prepare(
        `SELECT id, COALESCE(occurred_at, created_at) AS ts
           FROM units u
          WHERE status = 'active'${sql} AND COALESCE(occurred_at, created_at) >= ? AND COALESCE(occurred_at, created_at) < ?`,
      )
      .all(...args, win.from, win.to)

    const cand = []
    for (const row of rows) {
      const doc = corpus.docs.get(row.id)
      if (!doc) continue
      const s = corpus.bm25(doc.tf, doc.len, terms)
      if (s <= 0) continue
      cand.push({ id: row.id, score: s, ts: Number(row.ts) })
    }
    if (cand.length === 0) return { list: [], reason: `时间窗口「${win.label}」内无语义相关条目` }

    // 分桶：按窗口的日历跨度切桶（天窗口 1 桶，最多 8 桶）
    const spanDays = Math.max(1, (win.to - win.from) / 86400000)
    const bucketCount = Math.min(8, Math.max(1, Math.round(spanDays)))
    const bucketSize = (win.to - win.from) / bucketCount
    const buckets = new Map()
    for (const item of cand) {
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((item.ts - win.from) / bucketSize)))
      if (!buckets.has(idx)) buckets.set(idx, [])
      buckets.get(idx).push(item)
    }
    for (const list of buckets.values()) list.sort((a, b) => b.score - a.score)
    // 桶间轮转：每轮从每个（非空）桶取当前最优，直到装满 limit 或所有桶取空
    const order = [...buckets.values()].sort((a, b) => b[0].score - a[0].score)
    const picked = []
    for (let round = 0; picked.length < limit; round += 1) {
      let progressed = false
      for (const list of order) {
        if (round >= list.length) continue
        picked.push(list[round])
        progressed = true
        if (picked.length >= limit) break
      }
      if (!progressed) break
    }
    return {
      list: picked.map((r, i) => ({
        id: r.id,
        score: r.score,
        rank: i + 1,
        reason: `时间窗口 ${win.label}（分 ${order.length} 桶轮转取代表）`,
      })),
    }
  }

  /**
   * C4：关联图 + PPR（个性化 PageRank）。
   *
   * 种子来自已算好的词法/稀疏通道前若干名；沿 `edges`（coRetrieval 同批召回、
   * association 关联、derivedFrom 派生；contradicts 只作为弱负权重减分）游走。
   * 图的价值是"**词面没命中但与之强关联**"的条目：它的分数不来自查询词，
   * 而来自"被同一批取回过 / 被显式关联过"——这正是纯 BM25 补不上的那一类。
   *
   * 邻接表按 `store.stamp()` 缓存（写入即失效），避免每次检索都全表扫边。
   */
  graphIndex() {
    const stamp = this.store.stamp()
    if (this.graphCache && this.graphCache.stamp === stamp) return this.graphCache
    const adj = new Map()
    const push = (from, to, weight, kind) => {
      if (!adj.has(from)) adj.set(from, [])
      adj.get(from).push({ id: to, weight, kind })
    }
    const rows = this.store.db
      .prepare(
        `SELECT e.from_id, e.to_id, e.kind, e.weight
           FROM edges e
           JOIN units a ON a.id = e.from_id AND a.status = 'active'
           JOIN units b ON b.id = e.to_id AND b.status = 'active'`,
      )
      .all()
    for (const row of rows) {
      const w = row.kind === 'contradicts' ? -Math.abs(row.weight) * 0.3 : Math.abs(row.weight)
      // 无向游走：两个方向都能走（关联是双向的），权重按方向各存一份
      push(row.from_id, row.to_id, w, row.kind)
      push(row.to_id, row.from_id, w, row.kind)
    }
    this.graphCache = { stamp, adj, edges: rows.length }
    return this.graphCache
  }

  channelGraph(query, { scopes, limit, seeds = null }) {
    const cfg = this.config.channels.graph
    const { adj, edges } = this.graphIndex()
    if (edges < (cfg.minEdges ?? 20)) return { list: [], reason: `关联边不足（${edges} < ${cfg.minEdges ?? 20}）` }
    const seedList = (seeds ?? this.channelSparse(query, { scopes, limit: cfg.seedCount ?? 8 })).slice(0, cfg.seedCount ?? 8)
    if (seedList.length === 0) return { list: [], reason: '无种子（词法/稀疏都没命中）' }
    const scopeSet = !scopes || scopes === 'all' ? null : new Set(Array.isArray(scopes) ? scopes : [scopes])
    const allowed = scopeSet
      ? new Set(this.store.db.prepare('SELECT id, scope FROM units WHERE status = \'active\'').all().filter((r) => scopeSet.has(r.scope)).map((r) => r.id))
      : null

    const damping = cfg.damping ?? 0.85
    const iterations = cfg.iterations ?? 12
    const seedWeight = new Map()
    let seedTotal = 0
    for (const s of seedList) {
      const w = 1 / (s.rank ?? 1)
      seedWeight.set(s.id, w)
      seedTotal += w
    }
    let rank = new Map()
    for (const [id, w] of seedWeight) rank.set(id, w / seedTotal)
    for (let i = 0; i < iterations; i += 1) {
      const next = new Map()
      for (const [id, w] of seedWeight) next.set(id, (next.get(id) ?? 0) + (1 - damping) * (w / seedTotal))
      for (const [id, r] of rank) {
        if (r <= 0) continue
        const nbrs = adj.get(id)
        if (!nbrs || nbrs.length === 0) {
          next.set(id, (next.get(id) ?? 0) + damping * r)
          continue
        }
        const sum = nbrs.reduce((a, n) => a + Math.abs(n.weight), 0) || 1
        for (const n of nbrs) {
          if (allowed && !allowed.has(n.id)) continue
          next.set(n.id, (next.get(n.id) ?? 0) + damping * r * (n.weight / sum))
        }
      }
      rank = next
    }
    const scored = []
    for (const [id, score] of rank) {
      if (score <= 0) continue
      if (seedWeight.has(id)) continue // 种子已由词法通道给出，图通道只补"新面孔"
      const kinds = [...new Set((adj.get(id) ?? []).map((n) => n.kind))]
      scored.push({ id, score, reason: `PPR 关联（${kinds.join('/') || 'edge'}）` })
    }
    scored.sort((a, b) => b.score - a.score)
    return { list: scored.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 })) }
  }

  /**
   * C3：多粒度 + 熵路由。
   * 粒度：entry（条目自身）/ day（当日全部条目）/ trackScope（同轨同作用域聚合）/
   *       abstract（抽象层条目，M3 起产生）。
   */
  channelGranularity(query, { scopes, limit }) {
    const corpus = this.corpus.ensure()
    const terms = tokenize(query)
    const scopeSet = !scopes || scopes === 'all' ? null : new Set(Array.isArray(scopes) ? scopes : [scopes])
    const allow = (doc) => !scopeSet || scopeSet.has(doc.scope)

    const perGranularity = []

    // entry 粒度
    const entryScores = new Map()
    for (const doc of corpus.docs.values()) {
      if (!allow(doc)) continue
      const s = corpus.bm25(doc.tf, doc.len, terms)
      if (s > 0) entryScores.set(doc.id, s)
    }
    perGranularity.push({ name: 'entry', dist: minMaxNormalize(entryScores) })

    // 聚合粒度（day / trackScope / abstract）
    for (const kind of ['day', 'trackScope']) {
      const scores = new Map()
      for (const agg of corpus.aggregates[kind].values()) {
        if (agg.members.length < 2) continue
        const s = corpus.bm25(agg.tf, agg.len, terms)
        if (s <= 0) continue
        const discount = 1 / (1 + Math.log(agg.members.length))
        for (const id of agg.members) {
          const doc = corpus.docs.get(id)
          if (!doc || !allow(doc)) continue
          scores.set(id, Math.max(scores.get(id) ?? 0, s * discount))
        }
      }
      perGranularity.push({ name: kind, dist: minMaxNormalize(scores) })
    }

    const abstractScores = new Map()
    for (const doc of corpus.docs.values()) {
      if (doc.kind !== 'abstract' || !allow(doc)) continue
      const s = corpus.bm25(doc.tf, doc.len, terms)
      if (s > 0) abstractScores.set(doc.id, s)
    }
    perGranularity.push({ name: 'abstract', dist: minMaxNormalize(abstractScores) })

    // 熵路由：H 越低说明该粒度上有明确匹配 → 权重越高
    const entropies = perGranularity.map((g) => ({ name: g.name, h: entropyOf(g.dist) }))
    const positive = entropies.filter((e) => e.h > 1e-9)
    let weights
    if (positive.length === 0) {
      weights = new Map(entropies.map((e) => [e.name, 0]))
    } else {
      const hs = positive.map((e) => e.h)
      const ratio = Math.max(...hs) / Math.min(...hs)
      if (ratio < this.config.entropyUniformRatio) {
        // 无区分度 → 回落等权重
        weights = new Map(entropies.map((e) => [e.name, e.h > 1e-9 ? 1 / positive.length : 0]))
      } else {
        const invSum = positive.reduce((acc, e) => acc + 1 / e.h, 0)
        weights = new Map(entropies.map((e) => [e.name, e.h > 1e-9 ? 1 / e.h / invSum : 0]))
      }
    }

    const fused = new Map()
    for (const g of perGranularity) {
      const w = weights.get(g.name) ?? 0
      if (w <= 0) continue
      for (const [id, v] of g.dist) fused.set(id, (fused.get(id) ?? 0) + w * v)
    }
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    const dominant = [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    return ranked.map(([id, score], i) => ({
      id,
      score,
      rank: i + 1,
      reason: `粒度权重 ${[...weights.entries()].map(([n, w]) => `${n}=${w.toFixed(2)}`).join(' ')}；主导 ${dominant}`,
    }))
  }

  runChannel(name, query, opts, budget) {
    const started = Date.now()
    try {
      const out = this[`channel${name[0].toUpperCase()}${name.slice(1)}`](query, opts)
      const list = Array.isArray(out) ? out : (out?.list ?? [])
      const reason = Array.isArray(out) ? null : (out?.reason ?? null)
      return { name, list, ms: Date.now() - started, ...(reason ? { skippedReason: reason } : {}) }
    } catch (error) {
      return { name, list: [], ms: Date.now() - started, error: error.message }
    }
  }

  /**
   * 检索主入口。
   * @param {{ query: string, scopes?: string[]|'all', k?: number, budgetMs?: number }} params
   */
  search({ query, scopes = 'all', k = null, budgetMs = null, sessionId = null, log = null, now = null } = {}) {
    const cfg = this.config
    const started = Date.now()
    const topK = k ?? cfg.k
    const budget = budgetMs ?? cfg.budgetMs
    const degraded = []
    const channels = {}

    const coldStart = this.store.counts().unitsActive < cfg.coldStartUnits
    const plan = ['lexical', 'sparse', 'granularity']
    for (const name of plan) {
      const c = cfg.channels[name]
      if (!c?.enabled) {
        channels[name] = { list: [], ms: 0, skipped: c?.reason ?? 'disabled' }
        continue
      }
      if (coldStart && name !== 'lexical' && name !== 'sparse') {
        channels[name] = { list: [], ms: 0, skipped: '冷启动（记忆量低于阈值）' }
        degraded.push(`${name}:冷启动`)
        continue
      }
      if (Date.now() - started > budget) {
        channels[name] = { list: [], ms: 0, skipped: '超预算' }
        degraded.push(`${name}:超预算`)
        continue
      }
      const res = this.runChannel(name, query, { scopes, limit: cfg.perChannel }, budget)
      channels[name] = res
      if (res.error) degraded.push(`${name}:异常(${res.error})`)
    }
    if (!cfg.channels.graph?.enabled) {
      channels.graph = { list: [], ms: 0, skipped: cfg.channels.graph?.reason ?? 'disabled' }
    } else if (coldStart) {
      channels.graph = { list: [], ms: 0, skipped: '冷启动（记忆量低于阈值）' }
      degraded.push('graph:冷启动')
    } else if (Date.now() - started > budget) {
      channels.graph = { list: [], ms: 0, skipped: '超预算' }
      degraded.push('graph:超预算')
    } else {
      const seedMap = new Map()
      const collect = (list) => {
        for (const hit of list ?? []) if (!seedMap.has(hit.id)) seedMap.set(hit.id, { id: hit.id, rank: seedMap.size + 1, score: hit.score })
      }
      collect(channels.sparse?.list)
      collect(channels.lexical?.list)
      const res = this.runChannel('graph', query, { scopes, limit: cfg.perChannel, seeds: [...seedMap.values()].slice(0, cfg.channels.graph?.seedCount ?? 8) }, budget)
      channels.graph = res
      if (res.error) degraded.push(`graph:异常(${res.error})`)
      else if (res.skippedReason) channels.graph.skipped = res.skippedReason
    }
    // C5 时序通道：解析不出窗口 → 照 channelGraph 的 skippedReason 风格跳过
    if (!cfg.channels.temporal?.enabled) {
      channels.temporal = { list: [], ms: 0, skipped: cfg.channels.temporal?.reason ?? 'disabled' }
    } else if (coldStart) {
      channels.temporal = { list: [], ms: 0, skipped: '冷启动（记忆量低于阈值）' }
      degraded.push('temporal:冷启动')
    } else if (Date.now() - started > budget) {
      channels.temporal = { list: [], ms: 0, skipped: '超预算' }
      degraded.push('temporal:超预算')
    } else {
      const res = this.runChannel('temporal', query, { scopes, limit: cfg.perChannel, now }, budget)
      channels.temporal = res
      if (res.error) degraded.push(`temporal:异常(${res.error})`)
      else if (res.skippedReason) channels.temporal.skipped = res.skippedReason
    }
    if (this.corpus.truncated) degraded.push(`语料超过 ${cfg.maxCorpusDocs} 条，C2/C3 只覆盖前 N 条`)

    // --- RRF 融合（按排名，不看分数量纲）---
    const fused = new Map()
    const addList = (name, list) => {
      const weight = cfg.channels[name]?.weight ?? 1
      for (const hit of list) {
        const entry = fused.get(hit.id) ?? { id: hit.id, rrf: 0, channels: {} }
        entry.rrf += weight / (cfg.rrfK + hit.rank)
        entry.channels[name] = { rank: hit.rank, score: hit.score, reason: hit.reason ?? null }
        fused.set(hit.id, entry)
      }
    }
    addList('lexical', channels.lexical?.list ?? [])
    addList('sparse', channels.sparse?.list ?? [])
    // 保底席位：**只看 C1+C2 的纯 RRF**（加权层不得打穿这条设计约束）
    const baseline = [...fused.values()].sort((a, b) => b.rrf - a.rrf)
    addList('granularity', channels.granularity?.list ?? [])
    addList('graph', channels.graph?.list ?? []) // C4：图通道只进总榜，不占基线保底席位
    addList('temporal', channels.temporal?.list ?? []) // C5：同上，只进总榜

    // --- 乘性加权层（对标 hindsight Stage3）：只改总榜排序，不改保底席位 ---
    const boostCfg = cfg.boosts ?? {}
    // 与 channelTemporal 同一条缺省规则：null / 缺省 / 非有限数 → 回落 boosts.now → Date.now()。
    // （Number(null) === 0 是有限数：若照 Number.isFinite(Number(now)) 判，未传 now 的默认检索
    //   会把"当前时刻"当成 epoch → 每条 recency signal 恒为 1，recency 项退化成常数因子。）
    const boostNowOpt = now ?? boostCfg.now
    const boostNow = boostNowOpt == null || !Number.isFinite(Number(boostNowOpt)) ? Date.now() : Number(boostNowOpt)
    let boosted = 0
    for (const entry of fused.values()) {
      const info = this.boostFor(entry.id, boostNow)
      entry.boost = info.factor
      entry.signals = info.signals
      entry.score = entry.rrf * info.factor
      if (info.factor !== 1) boosted += 1
    }
    const overall = [...fused.values()].sort((a, b) => b.score - a.score)

    // --- 基线保底：至少一半席位留给 C1+C2 ---
    //
    // **保证的范围（明示契约，实测于 t6 核验）**：保底只保**席位集合** ——
    // 最终 top-k 里至少有 `seats` 条来自 **纯 C1+C2 的 RRF 排序**（不受加权层影响），
    // 即 baselineIds ≡ baseline.slice(0, seats)，本条由单测逐条钉住。
    //
    // 它**不保证这些席位在 top-k 内的名次**：下面 `selected.sort(by overallOrder)` 让全部
    // 命中按总榜（含加权）顺序输出，因此加权可能把保底条目压到列表尾部（真实库快照实测
    // 22/24 条查询出现位移，但席位 24/24 仍在榜内）。想连名次一起保就要改排序，而那样会顶掉
    // 加权层的排序价值 —— 设计上不取这条路。
    const seats = Math.max(1, Math.floor(topK * cfg.baselineFloor))
    const selected = []
    const taken = new Set()
    const baselineIds = []
    for (const hit of baseline.slice(0, seats)) {
      selected.push(hit.id)
      taken.add(hit.id)
      baselineIds.push(hit.id)
    }
    for (const hit of overall) {
      if (selected.length >= topK) break
      if (taken.has(hit.id)) continue
      selected.push(hit.id)
      taken.add(hit.id)
    }
    // 只在这里决定"谁进 top-k"；名次完全交给总榜顺序（见上方"保证的范围"）
    const order = new Map(overall.map((h, i) => [h.id, i]))
    selected.sort((a, b) => order.get(a) - order.get(b))

    const byId = new Map(overall.map((h) => [h.id, h]))
    const hits = selected.map((id, i) => {
      const entry = byId.get(id)
      const doc = this.corpus.docs.get(id)
      return {
        id,
        rank: i + 1,
        rrf: entry.rrf,
        // score = rrf × 加权因子；boost ≠ 1 时 score ≠ rrf（加权层只影响总榜排序）
        score: entry.score ?? entry.rrf,
        boost: entry.boost ?? 1,
        signals: entry.signals ?? null,
        channels: entry.channels,
        track: doc?.track ?? null,
        kind: doc?.kind ?? null,
        scope: doc?.scope ?? null,
        createdAt: doc?.createdAt ?? null,
        occurredAt: doc?.occurredAt ?? null,
        snippet: doc ? doc.content.replace(/\s+/g, ' ').slice(0, 160) : '',
        content: doc?.content ?? '',
        origin: doc?.origin ?? null,
        quarantined: doc?.quarantined === true,
      }
    })

    const evidence = this.evaluateEvidence(query, hits, channels)
    if (log ?? this.config.logRecall !== false) this.logRecall({ query, hits, evidence, sessionId })
    return {
      query,
      scopes,
      k: topK,
      hits,
      evidence,
      channels: Object.fromEntries(
        Object.entries(channels).map(([name, v]) => [
          name,
          { ms: v.ms ?? 0, count: v.list?.length ?? 0, skipped: v.skipped ?? null, error: v.error ?? null },
        ]),
      ),
      degraded,
      ms: Date.now() - started,
      baselineSeats: seats,
      // 保底席位实际取到的 id（按纯 C1+C2 RRF 顺序）—— 供归因与"加权不得打穿"的验收核对
      baselineIds,
      boosted,
      coldStart,
    }
  }

  /**
   * 单条命中的加权因子（乘性）：四个信号各出一个 boost，相乘。
   *
   *   boost = (1 + recencyAlpha×(recency−0.5)) × (1 + importanceAlpha×(importance−0.5))
   *         × (1 + usageAlpha×(usage−0.5))     × (1 + proofAlpha×(proof−0.5))
   *
   * enabled=false → 恒为 1（且不读语料，保证与改造前逐位等价）；
   * 全部 α=0 → 每个括号都是 1.0，乘积也是 1.0（浮点精确）。
   */
  boostFor(id, now = Date.now()) {
    const cfg = this.config.boosts ?? {}
    if (cfg.enabled === false) return { factor: 1, signals: null }
    const doc = this.corpus.docs.get(id)
    const signals = {
      recency: signalRecency(doc?.occurredAt ?? doc?.createdAt ?? null, now, cfg.recencySpanDays),
      importance: signalImportance(doc?.importance),
      usage: signalUsage(doc?.accessCount, cfg.usageReference),
      proof: signalProof(doc?.kind, doc?.proofCount),
    }
    const factor =
      (1 + num(cfg.recencyAlpha) * (signals.recency - 0.5)) *
      (1 + num(cfg.importanceAlpha) * (signals.importance - 0.5)) *
      (1 + num(cfg.usageAlpha) * (signals.usage - 0.5)) *
      (1 + num(cfg.proofAlpha) * (signals.proof - 0.5))
    return { factor, signals }
  }

  /** 归因留档（设计 §6.4）：事后可复盘"这次为什么召回 / 没召回"。 */
  logRecall({ query, hits, evidence, sessionId = null }) {
    try {
      const stmt = this.store.db.prepare(
        'INSERT INTO recall_log (ts, session_id, query, unit_id, channel, rank, score, injected, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      const ts = Date.now()
      for (const hit of hits.slice(0, this.config.perChannel ?? 50)) {
        stmt.run(
          ts,
          sessionId,
          String(query).slice(0, 500),
          hit.id,
          Object.keys(hit.channels ?? {}).join('+') || null,
          hit.rank,
          hit.rrf,
          evidence.inject && hit.rank <= 3 ? 1 : 0,
          (evidence.reasons.find((r) => r.startsWith(hit.id)) ?? null)?.slice(0, 300) ?? null,
        )
      }
    } catch {
      /* 留档失败绝不影响检索 */
    }
  }

  /**
   * 证据判定（§6.2）：注入不看 RRF 分数（它只编码排名），看证据。
   * 证据 = 两通道同时命中 / 单通道强证据（前 N 名 或 bm25 相对分高）/ 实体精确命中。
   */
  evaluateEvidence(query, hits, channels) {
    const cfg = this.config.evidence
    const queryEntities = extractEntities(query)
    const maxBm25 = Math.max(0, ...(channels.lexical?.list ?? []).map((h) => h.score))
    const rankIn = (name, id) => channels[name]?.list?.find((h) => h.id === id)?.rank ?? null
    const reasons = []
    let strong = false

    for (const hit of hits) {
      const chans = hit.channels ?? {}
      const channelCount = Object.keys(chans).length
      if (channelCount >= 2) {
        reasons.push(`${hit.id}:两通道同时命中（${Object.keys(chans).join('+')}）`)
        strong = true
      }
      const lexRank = rankIn('lexical', hit.id)
      if (lexRank !== null && lexRank <= cfg.topRank) {
        reasons.push(`${hit.id}:词法前 ${lexRank}`)
        strong = true
      }
      const sparseRank = rankIn('sparse', hit.id)
      if (sparseRank !== null && sparseRank <= cfg.topRank) {
        reasons.push(`${hit.id}:稀疏语义前 ${sparseRank}`)
        strong = true
      }
      const doc = this.corpus.docs.get(hit.id)
      if (doc && queryEntities.length > 0) {
        // 与 C2 同一条归一化判据：写法差异（大小写/空白/全角/分隔符）不再漏判
        const exact = queryEntities.find((e) => entityMatches(e, [...doc.ents]))
        if (exact) {
          reasons.push(`${hit.id}:实体精确命中（${exact}）`)
          strong = true
        }
      }
      if (maxBm25 > 0 && chans.lexical && chans.lexical.score / maxBm25 >= cfg.bm25Ratio) {
        reasons.push(`${hit.id}:bm25 相对分 ${(chans.lexical.score / maxBm25).toFixed(2)}`)
        strong = true
      }
    }
    return { inject: strong, reasons: reasons.slice(0, 8) }
  }

  /** 归因诊断：各通道原始列表 + 融合过程（§6.4）。 */
  diag(query = '', { scopes = 'all', limit = 8 } = {}) {
    const result = this.search({ query, scopes, k: limit })
    const corpus = this.corpus.ensure()
    const detail = (list) =>
      list.slice(0, limit).map((h) => ({
        id: h.id,
        rank: h.rank,
        score: Number(h.score?.toFixed?.(4) ?? h.score),
        track: corpus.docs.get(h.id)?.track ?? null,
        head: corpus.docs.get(h.id)?.content.replace(/\s+/g, ' ').slice(0, 70) ?? '',
      }))
    const temporal = this.channelTemporal(query, { scopes, limit })
    // channelTemporal 恒返回 { list, reason }（它不是数组）—— 这里直接取，不再留 Array 兼容分支
    const temporalList = temporal.list ?? []
    return {
      query,
      channels: {
        lexical: this.channelLexical(query, { scopes, limit }),
        sparse: this.channelSparse(query, { scopes, limit }),
        granularity: this.channelGranularity(query, { scopes, limit }),
        graph: [],
        temporal: temporalList,
        temporalSkipped: temporal.reason ?? null,
      },
      fused: result.hits,
      evidence: result.evidence,
      degraded: result.degraded,
      ms: result.ms,
      formatter: () => {
        const lines = [`查询「${query}」（${result.ms} ms${result.degraded.length ? ` · 降级 ${result.degraded.join(',')}` : ''}）`]
        for (const [name, list] of Object.entries({
          lexical: this.channelLexical(query, { scopes, limit }),
          sparse: this.channelSparse(query, { scopes, limit }),
          granularity: this.channelGranularity(query, { scopes, limit }),
          temporal: temporalList,
        })) {
          lines.push(`  ── ${name} ──`)
          if (name === 'temporal' && temporalList.length === 0) {
            lines.push(`   跳过：${temporal.reason ?? '无结果'}`)
            continue
          }
          for (const d of detail(list)) lines.push(`   #${d.rank} [${d.id}] ${d.track ?? '-'} ${d.score}  ${d.head}`)
        }
        lines.push(`  ── 融合（保底席位 ${result.baselineSeats}，加权 ${result.boosted ?? 0} 条）──`)
        for (const h of result.hits) {
          const boost = (h.boost ?? 1) !== 1 ? ` boost=${h.boost.toFixed(3)}` : ''
          lines.push(`   #${h.rank} [${h.id}] ${h.track ?? '-'} rrf=${h.rrf.toFixed(5)}${boost} 通道=${Object.keys(h.channels).join('+')}  ${h.snippet.slice(0, 60)}`)
        }
        lines.push(`  证据：${result.evidence.inject ? '达标' : '不足'} ${result.evidence.reasons.join(' | ')}`)
        return lines.join('\n')
      },
    }
  }
}

/** 便捷工厂。 */
export function createRecall(store, config = {}) {
  return new Recall(store, config)
}
