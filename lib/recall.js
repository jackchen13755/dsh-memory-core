/**
 * 召回引擎（设计 §6）：四通道并行 → RRF 融合 → 基线保底 → 证据判定 → 归因。
 *
 * 通道：
 *   C1 lexical     SQLite FTS5（bigram + 标识符），bm25 排序
 *   C2 sparse      JS BM25 + 元数据加权（实体精确命中 / summary / 标签）
 *   C3 granularity 条目 / 当日 / 项目轨 / 抽象 四种粒度分别打分，熵路由分配权重
 *   C4 graph       M5 接入（当前显式声明 disabled，带原因）
 *
 * 三条设计硬约束（§2）：
 *   可降级 —— 任一通道异常/超时都跳过，其余照常融合；全失败返回空 + 原因
 *   不劣化 —— 最终 top-k 至少一半席位留给 C1+C2 的融合结果
 *   可归因 —— 每条命中都能说清"哪条通道、什么排名、为什么"
 */
import { ftsQuery, tokenize } from './tokens.js'
import { extractEntities } from './entities.js'

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
  },
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
    evidence: { ...DEFAULT_CONFIG.evidence, ...(config.evidence ?? {}) },
  }
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
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m, COALESCE(MAX(updated_at), 0) AS t FROM units')
      .get()
    const stamp = `${row.n}:${row.m}:${row.t}`
    if (stamp === this.stamp) return this
    this.stamp = stamp
    this.build()
    return this
  }

  build() {
    this.docs.clear()
    this.df.clear()
    this.aggregates.day.clear()
    this.aggregates.trackScope.clear()
    const rows = this.store.db
      .prepare("SELECT id, track, scope, kind, day, meta, tokens, content, created_at FROM units WHERE status = 'active' ORDER BY rowid LIMIT ?")
      .all(this.maxDocs + 1)
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
        aliases: (meta.alias ?? []).map((a) => String(a)),
        tags: (meta.tags ?? []).map((t) => String(t)),
        summary: meta.summary ?? '',
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

  /** C2：JS BM25 + 元数据加权（实体精确 / 摘要 / 标签）。 */
  channelSparse(query, { scopes, limit }) {
    const corpus = this.corpus.ensure()
    const terms = tokenize(query)
    const queryEntities = extractEntities(query).map((e) => e.toLowerCase())
    const scopeSet = !scopes || scopes === 'all' ? null : new Set(Array.isArray(scopes) ? scopes : [scopes])
    const scored = []
    for (const doc of corpus.docs.values()) {
      if (scopeSet && !scopeSet.has(doc.scope)) continue
      let score = corpus.bm25(doc.tf, doc.len, terms)
      for (const ent of queryEntities) {
        if (doc.ents.has(ent)) score += 4
        else if ([...doc.ents].some((e) => e.includes(ent) || ent.includes(e))) score += 1.5
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
  search({ query, scopes = 'all', k = null, budgetMs = null, sessionId = null, log = null } = {}) {
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
    const baseline = [...fused.values()].sort((a, b) => b.rrf - a.rrf)
    addList('granularity', channels.granularity?.list ?? [])
    addList('graph', channels.graph?.list ?? []) // C4：图通道只进总榜，不占基线保底席位
    const overall = [...fused.values()].sort((a, b) => b.rrf - a.rrf)

    // --- 基线保底：至少一半席位留给 C1+C2 ---
    const seats = Math.max(1, Math.floor(topK * cfg.baselineFloor))
    const selected = []
    const taken = new Set()
    for (const hit of baseline.slice(0, seats)) {
      selected.push(hit.id)
      taken.add(hit.id)
    }
    for (const hit of overall) {
      if (selected.length >= topK) break
      if (taken.has(hit.id)) continue
      selected.push(hit.id)
      taken.add(hit.id)
    }
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
        channels: entry.channels,
        track: doc?.track ?? null,
        kind: doc?.kind ?? null,
        scope: doc?.scope ?? null,
        createdAt: doc?.createdAt ?? null,
        snippet: doc ? doc.content.replace(/\s+/g, ' ').slice(0, 160) : '',
        content: doc?.content ?? '',
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
      coldStart,
    }
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
    const queryEntities = extractEntities(query).map((e) => e.toLowerCase())
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
        const exact = queryEntities.find((e) => doc.ents.has(e))
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
  diag(query, { scopes = 'all', limit = 8 } = {}) {
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
    return {
      query,
      channels: {
        lexical: this.channelLexical(query, { scopes, limit }),
        sparse: this.channelSparse(query, { scopes, limit }),
        granularity: this.channelGranularity(query, { scopes, limit }),
        graph: [],
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
        })) {
          lines.push(`  ── ${name} ──`)
          for (const d of detail(list)) lines.push(`   #${d.rank} [${d.id}] ${d.track ?? '-'} ${d.score}  ${d.head}`)
        }
        lines.push(`  ── 融合（保底席位 ${result.baselineSeats}）──`)
        for (const h of result.hits) {
          lines.push(`   #${h.rank} [${h.id}] ${h.track ?? '-'} rrf=${h.rrf.toFixed(5)} 通道=${Object.keys(h.channels).join('+')}  ${h.snippet.slice(0, 60)}`)
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
