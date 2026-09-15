/**
 * 演化（设计 §8）：后台过程，全部幂等、可恢复、失败互不影响。
 *
 * 六个过程在 M3 落地四个（另两个：关联建边在图通道期做、重关联随图一起）：
 *   reinforce  强化 —— 被召回/取回过的条目加权；同批召回的条目之间建 coRetrieval 边
 *   decay      衰减 —— importance 按半衰期指数衰减，低于阈值转 archived（**只归档不删除**，pin 豁免）
 *   reconcile  调和 —— 近似重复合并 / 版本链取代 / 冲突标记（无 LLM 用启发式；有 LLM 走严格 JSON）
 *   abstract   抽象 —— 相关条目成簇后汇总成更高层条目（**叠加不替换**，来源保持 active）
 *
 * 外加**写入看门狗**（设计 §5.6）：长会话里"每轮写记忆"的提示会逐渐失效，程序侧统计
 * "连续多少轮没写任何记忆"，超阈值就在快照里置顶提醒，写入即消。
 */
import { sha1 } from './paths.js'
import { overlapCoefficient, similarity } from './writer.js'

export const EVOLVE_DEFAULTS = {
  enabled: true,
  intervalMinutes: 30,
  decayHalfLifeDays: 30,
  decayGraceDays: 30, // 宽限期：刚导入/新建的记忆不参与衰减（首次运行不该一上来就归档老资产）
  archiveBelow: 0.15,
  reinforceBoost: 0.08,
  reinforceWindowHours: 72,
  reconcileOverlap: 0.82,
  reconcileSimilarity: 0.75,
  reconcileMaxPairs: 40,
  abstractClusterSize: 12,
  minImportance: 0.05,
  maxImportance: 1,
  writeGuard: { enabled: false, threshold: 2 },
  llm: { reconcile: false, abstract: false },
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/** 强化：以 recall_log 为证据给"真正被取回过的"条目加权，并在同批召回之间建边。 */
export function reinforce({ store, config = EVOLVE_DEFAULTS, now = Date.now() } = {}) {
  const cfg = { ...EVOLVE_DEFAULTS, ...config }
  const since = now - cfg.reinforceWindowHours * 3600000
  const rows = store.db
    .prepare(
      `SELECT unit_id, COUNT(*) AS hits, MAX(ts) AS last_ts, SUM(injected) AS injected
         FROM recall_log WHERE ts >= ? AND unit_id IS NOT NULL GROUP BY unit_id`,
    )
    .all(since)
  let boosted = 0
  let edges = 0
  const tx = store.db
  tx.exec('BEGIN')
  try {
    for (const row of rows) {
      const unit = store.db.prepare('SELECT id, importance, pinned FROM units WHERE id = ?').get(row.unit_id)
      if (!unit) continue
      const gain = cfg.reinforceBoost * Math.min(3, Number(row.hits)) * (Number(row.injected) > 0 ? 1.5 : 1)
      const next = clamp(Number(unit.importance) + gain, cfg.minImportance, cfg.maxImportance)
      store.db.prepare('UPDATE units SET importance = ?, access_count = access_count + ? WHERE id = ?').run(next, Number(row.hits), row.unit_id)
      boosted += 1
    }
    // 同一次检索里共同出现的条目 → coRetrieval 边（查询维度：同一 ts 的前 3 名）
    const batches = store.db
      .prepare(
        `SELECT ts, GROUP_CONCAT(unit_id) AS ids FROM recall_log
          WHERE ts >= ? AND rank <= 3 GROUP BY ts HAVING COUNT(*) > 1 LIMIT 500`,
      )
      .all(since)
    for (const batch of batches) {
      const ids = String(batch.ids ?? '').split(',').filter(Boolean)
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          store.db
            .prepare(
              `INSERT INTO edges (from_id, to_id, kind, weight) VALUES (?, ?, 'coRetrieval', 1)
               ON CONFLICT(from_id, to_id, kind) DO UPDATE SET weight = weight + 1`,
            )
            .run(ids[i], ids[j])
          edges += 1
        }
      }
    }
    tx.exec('COMMIT')
  } catch (error) {
    tx.exec('ROLLBACK')
    return { ok: false, step: 'reinforce', message: error.message }
  }
  return { ok: true, step: 'reinforce', boosted, edges, scanned: rows.length }
}

/** 衰减与归档：指数半衰期；低于阈值转 archived（可恢复，pin 豁免）。 */
export function decay({ store, config = EVOLVE_DEFAULTS, now = Date.now() } = {}) {
  const cfg = { ...EVOLVE_DEFAULTS, ...config }
  const rows = store.db.prepare("SELECT id, importance, pinned, last_accessed, updated_at, created_at FROM units WHERE status = 'active'").all()
  let decayed = 0
  let archived = 0
  const tx = store.db
  tx.exec('BEGIN')
  try {
    for (const row of rows) {
      if (Number(row.pinned) === 1) continue
      const last = Number(row.last_accessed ?? row.updated_at ?? row.created_at)
      const days = Math.max(0, (now - last) / 86400000)
      const ageDays = Math.max(0, (now - Number(row.created_at ?? now)) / 86400000)
      if (days < 1) continue
      // 宽限期：新建/刚导入的记忆不衰减（避免首次巡演把历史资产一次性判死）
      if (cfg.decayGraceDays > 0 && ageDays < cfg.decayGraceDays) continue
      const factor = Math.pow(0.5, days / cfg.decayHalfLifeDays)
      const next = clamp(Number(row.importance) * factor, 0, cfg.maxImportance)
      if (Math.abs(next - Number(row.importance)) > 1e-6) {
        store.db.prepare('UPDATE units SET importance = ? WHERE id = ?').run(next, row.id)
        decayed += 1
      }
      if (next < cfg.archiveBelow) {
        store.db.prepare("UPDATE units SET status = 'archived' WHERE id = ?").run(row.id)
        store.logChange('unit', row.id, 'status', { status: 'archived', reason: 'decay' })
        archived += 1
      }
    }
    tx.exec('COMMIT')
  } catch (error) {
    tx.exec('ROLLBACK')
    return { ok: false, step: 'decay', message: error.message }
  }
  return { ok: true, step: 'decay', decayed, archived, scanned: rows.length }
}

/**
 * 调和（无 LLM 的启发式版）：同轨同作用域内相似度 ≥ 阈值的一对 →
 * 保留较旧（信息更完整）的一条，把较新的一条标记为 superseded 并建 supersedes 边。
 * **不物理删除**；判定为冲突（数字/路径不同）的成对保留并建 contradicts 边。
 */
export function reconcile({ store, config = EVOLVE_DEFAULTS, now = Date.now() } = {}) {
  const cfg = { ...EVOLVE_DEFAULTS, ...config }
  const rows = store.db
    .prepare("SELECT id, track, scope, content, importance, created_at FROM units WHERE status = 'active' ORDER BY created_at")
    .all()
  const byGroup = new Map()
  for (const row of rows) {
    const key = `${row.track}|${row.scope}`
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key).push(row)
  }
  let merged = 0
  let conflicts = 0
  let pairs = 0
  for (const group of byGroup.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length && pairs < cfg.reconcileMaxPairs; i += 1) {
      for (let j = i + 1; j < group.length && pairs < cfg.reconcileMaxPairs; j += 1) {
        const a = group[i]
        const b = group[j]
        if (sha1(a.content) === sha1(b.content)) continue
        // 中文 bigram 下 Jaccard 对"同义改写"过于苛刻，用重叠系数判"同一件事"
        const overlap = overlapCoefficient(a.content, b.content)
        if (overlap < cfg.reconcileOverlap) continue
        pairs += 1
        const digitKey = (s) => (String(s).match(/\d+/g) ?? []).join(',')
        const sameDigits = digitKey(a.content) === digitKey(b.content)
        const newer = a.created_at > b.created_at ? a : b
        const older = newer === a ? b : a
        if (sameDigits) {
          store.db
            .prepare("UPDATE units SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
            .run(older.id, now, newer.id)
          store.db
            .prepare("INSERT OR REPLACE INTO edges (from_id, to_id, kind, weight) VALUES (?, ?, 'supersedes', 1)")
            .run(newer.id, older.id)
          store.logChange('unit', older.id, 'status', { status: 'superseded', superseded_by: newer.id, reason: 'reconcile' })
          merged += 1
        } else {
          store.db
            .prepare("INSERT OR REPLACE INTO edges (from_id, to_id, kind, weight) VALUES (?, ?, 'contradicts', 1)")
            .run(newer.id, older.id)
          conflicts += 1
        }
      }
    }
  }
  return { ok: true, step: 'reconcile', merged, conflicts, pairs, scanned: rows.length }
}

/**
 * 抽象（需要 LLM，默认关）：把同轨同作用域内 importance 较高的一簇条目汇总成一条
 * `kind='abstract'` 的更高层条目。**叠加不替换**：来源条目保持 active。
 */
export async function abstractCluster({ store, llm, route, config = EVOLVE_DEFAULTS, now = Date.now(), log = () => {} } = {}) {
  const cfg = { ...EVOLVE_DEFAULTS, ...config }
  if (!llm || !route) return { ok: false, step: 'abstract', reason: '没有可用的模型路由' }
  const rows = store.db
    .prepare("SELECT id, track, scope, content FROM units WHERE status = 'active' AND kind != 'abstract' ORDER BY importance DESC LIMIT 200")
    .all()
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.track}|${row.scope}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  let created = 0
  for (const [key, group] of groups) {
    if (group.length < cfg.abstractClusterSize) continue
    const already = store.db.prepare("SELECT id FROM units WHERE kind = 'abstract' AND meta LIKE ?").get(`%${key}%`)
    if (already) continue
    const [track, scope] = key.split('|')
    const prompt = [
      `下面是「${key}」这个范围里积累的 ${group.length} 条记忆（每条前面是 id）。`,
      '请把它们归纳成 1-3 条更高层的约定或画像，每条自包含、可独立阅读、保留关键标识符。',
      '严格输出 JSON：{"items":[{"content":"...","kind":"rule|preference|fact|decision|pitfall|env"}]}',
      '',
      group.map((g) => `[${g.id}] ${g.content.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n'),
    ].join('\n')
    try {
      let text = ''
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: '你是记忆归纳器，只输出严格 JSON。',
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: cfg.abstractMaxTokens ?? 4000,
        reasoningEffort: 'off',
      })
      for await (const record of stream) if (record?.type === 'text-delta' && typeof record.text === 'string') text += record.text
      const json = (() => {
        const m = /\{[\s\S]*\}/.exec(text)
        if (!m) return null
        try {
          return JSON.parse(m[0])
        } catch {
          return null
        }
      })()
      for (const item of json?.items ?? []) {
        const content = String(item.content ?? '').trim()
        if (content.length < 8) continue
        const res = store.insertUnit(
          {
            track,
            scope,
            kind: 'abstract',
            content,
            meta: { derivedFrom: group.map((g) => g.id), group: key, generatedBy: 'abstract' },
            importance: 0.5,
            origin: 'evolve:abstract',
          },
          { record: true },
        )
        if (res.inserted) {
          for (const g of group) {
            store.db
              .prepare("INSERT OR REPLACE INTO edges (from_id, to_id, kind, weight) VALUES (?, ?, 'derivedFrom', 1)")
              .run(res.id, g.id)
          }
          created += 1
        }
      }
    } catch (error) {
      log(`抽象失败（${key}）：${error.message}`)
    }
  }
  return { ok: true, step: 'abstract', created, groups: groups.size }
}

/** 一次演化巡演：各过程独立容错，报告可用于展示。 */
export async function runEvolution({ store, llm = null, route = null, config = EVOLVE_DEFAULTS, now = Date.now(), log = () => {} } = {}) {
  const cfg = { ...EVOLVE_DEFAULTS, ...config }
  const report = { at: new Date(now).toISOString(), steps: [] }
  const guard = (fn) => {
    try {
      const res = fn()
      report.steps.push(res)
      return res
    } catch (error) {
      const res = { ok: false, message: error.message }
      report.steps.push(res)
      log(`演化步骤失败：${error.message}`)
      return res
    }
  }
  guard(() => reinforce({ store, config: cfg, now }))
  guard(() => reconcile({ store, config: cfg, now }))
  guard(() => decay({ store, config: cfg, now }))
  if (cfg.llm?.abstract && llm && route) {
    try {
      report.steps.push(await abstractCluster({ store, llm, route, config: cfg, now, log }))
    } catch (error) {
      report.steps.push({ ok: false, step: 'abstract', message: error.message })
    }
  }
  store.setMeta('evolve_last_run', JSON.stringify(report))
  return report
}

/**
 * 写入看门狗（设计 §5.6）：统计"连续多少轮没写任何记忆"。
 * 默认关闭（与旧插件一致：根源是模型指令遵循能力，强遵循模型不需要）。开启后
 * 达到阈值即在快照置顶提醒，**粘性**直到下一次写入。
 */
export class WriteWatchdog {
  constructor({ enabled = false, threshold = 2 } = {}) {
    this.enabled = enabled
    this.threshold = Math.max(1, Number(threshold) || 2)
    this.sessions = new Map() // id → { turns, lastWriteTurn, warned }
  }

  noteTurn(sessionId) {
    if (!this.enabled || !sessionId) return
    const s = this.sessions.get(sessionId) ?? { turns: 0, lastWriteTurn: 0, warned: false }
    s.turns += 1
    this.sessions.set(sessionId, s)
  }

  noteWrite(sessionId) {
    if (!this.enabled || !sessionId) return
    const s = this.sessions.get(sessionId) ?? { turns: 0, lastWriteTurn: 0, warned: false }
    s.lastWriteTurn = s.turns
    s.warned = false
    this.sessions.set(sessionId, s)
  }

  /** 需要提醒时返回一行提示文本（粘性），否则 null。 */
  warningFor(sessionId) {
    if (!this.enabled || !sessionId) return null
    const s = this.sessions.get(sessionId)
    if (!s) return null
    const gap = s.turns - s.lastWriteTurn
    if (gap < this.threshold) return null
    s.warned = true
    return `⚠️ 已连续 ${gap} 轮没有写入任何记忆：收尾时请用 mem_write 把本回合进展写入 project/daily。`
  }
}
