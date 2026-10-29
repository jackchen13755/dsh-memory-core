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
import { verifyArtifacts } from './artifacts.js'
import { overlapCoefficient, similarity } from './writer.js'

export const EVOLVE_DEFAULTS = {
  enabled: true,
  intervalMinutes: 30,
  decayHalfLifeDays: 30,
  decayGraceDays: 30, // 宽限期：刚导入/新建的记忆不参与衰减（首次运行不该一上来就归档老资产）
  archiveBelow: 0.15,
  /**
   * 取回宽限（止血项，2026-10-14）：recency 只该是排序信号，不该是删除决策。
   * access_count > 0 的条目已被真实取回过 → **本轮一律不归档**（importance 仍照常衰减，
   * 排序自然靠后，但记忆不消失）；access_count = 0 的才是「从未被取回」的可归档对象。
   * 语义：归档阈值 archiveBelow 的额外宽限倍率——> 0 即开启该保护，置 0 完全恢复旧行为。
   */
  decayAccessGrace: 2,
  reinforceBoost: 0.08,
  reinforceWindowHours: 72,
  /** 强化时自愈「importance 已回到阈值以上却仍是 archived」的矛盾态（见 reviveArchivedBoosted）。 */
  reviveOnReinforce: true,
  /**
   * 自愈判据对称开关（t8）：true = 除了 importance 达标的矛盾态，还救「access_count > 0 且
   * 确定带 decay 归档痕迹」的历史误杀条目（decay 的新规则说这类本不该被归档）。
   * 判据要求 changes 里有 reason='decay' 的归档记录，因此**不会**碰到用户手动归档
   * （无 reason 或 reason 是人话）与 legacy 导入的归档（无任何 changes 痕迹）。
   */
  reviveAccessCounted: true,
  /**
   * 历史误杀的收窄开关（默认 false = 全救）。true 时只救「可沉淀」轨（track≠daily 且 kind≠progress），
   * 让逐日流水/进行中快照按原样留在 archived。
   *
   * 为什么默认 false：判据的正当性来自**归档来源**（decay 误杀），而不是内容价值。按 track/kind
   * 过滤等于用「内容是否值得沉淀」偷换「归档是否误杀」——那是另一套保留策略，且会漏掉合法的
   * daily/progress 受害者（实测开启后仍有 1 个标注集期望 id 停在 archived）。该开关只为让运营方在
   * 「保留策略」上做显式、可复现的选择，绝不允许用它去拟合评测指标。
   */
  reviveDurableOnly: false,
  reconcileOverlap: 0.82,
  reconcileSimilarity: 0.75,
  reconcileMaxPairs: 40,
  abstractClusterSize: 12,
  minImportance: 0.05,
  maxImportance: 1,
  writeGuard: { enabled: false, threshold: 2 },
  llm: { reconcile: false, abstract: false },
  /**
   * 产物指纹的相对路径基准目录。null = 只核绝对路径与 ~/ 路径。
   * 想覆盖 `lib/schema.js` 这类相对写法就必须配它（例如配成项目根）。
   */
  artifactCwd: null,
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/** 强化：以 recall_log 为证据给"真正被取回过的"条目加权，并在同批召回之间建边。 */
export function reinforce({ store, config = EVOLVE_DEFAULTS, now = Date.now() } = {}) {
  const cfg = { ...EVOLVE_DEFAULTS, ...config }
  const since = now - cfg.reinforceWindowHours * 3600000
  /**
   * 消费水位（2026-10-29）：activation 是 append-only 事件，权重应由**尚未消费过**的激活
   * 聚合而来，而不是每次巡演把窗口内日志再累加一遍。
   *
   * 修复前：每次巡演都重扫 ts >= now-72h 的全部 recall_log 并直接累加，于是同一条激活在
   * 72 小时窗口内被重复计入最多约 144 次（30 分钟一轮）——importance 迅速撞到 maxImportance
   * 上限，权重退化成"取回过 / 没取回过"的二值；access_count 同步虚高，而 decay 的免归档
   * 宽限与 reviveArchivedBoosted 的两个判据读的正是这个虚高值。
   *
   * 水位用 rowid 而不是 ts：同一毫秒内会批量写入多条检索归因，用 ts 做 `>` 会漏掉同毫秒的
   * 新行，做 `>=` 又会重复消费边界批次。rowid 单调递增且与写入顺序一致，无此问题。
   * 窗口条件保留：超出窗口的历史激活仍不计入（避免升级后一次性补算陈年日志）。
   */
  /**
   * **两个独立水位**，各管各的消费范围（踩过的坑：合并成一个会互相顶）。
   *
   * boost 查询没有 rank 过滤、没有 LIMIT，覆盖整个窗口 → 它的 max(rowid) 是**全局最大**。
   * 若拿它去推进水位，下面 `LIMIT 500` 的边批次就会被一次性标记成"已消费"，
   * 剩下的批次永远不再处理（实测 600 批只建了 500 批的边）。
   * 所以：boost 用自己的水位，边用自己的水位，边水位只推进到**确实处理过的最后一批**。
   *
   * 另一个已知局限（不在这轮修，记在这里）：rowid 水位不抗 VACUUM 重排 ——
   * recall_log 没有 INTEGER PRIMARY KEY，灾备恢复（VACUUM INTO 出的副本）后 rowid 可能变小，
   * 水位就会大于新库最大 rowid、强化停摆。下面用 `Math.min` 做了一道自愈：
   * 水位若超过当前库的最大 rowid，视为失效并归零重来。
   */
  const maxRowid = Number(store.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM recall_log').get()?.n ?? 0)
  const rawBoostWm = Number(store.getMeta('evolve_reinforce_rowid', '0')) || 0
  const rawEdgeWm = Number(store.getMeta('evolve_edge_rowid', '0')) || 0
  const fromRowid = rawBoostWm > maxRowid ? 0 : rawBoostWm
  const fromEdgeRowid = rawEdgeWm > maxRowid ? 0 : rawEdgeWm
  const rows = store.db
    .prepare(
      `SELECT unit_id, COUNT(*) AS hits, MAX(ts) AS last_ts, SUM(injected) AS injected, MAX(rowid) AS max_rowid
         FROM recall_log WHERE rowid > ? AND ts >= ? AND unit_id IS NOT NULL GROUP BY unit_id`,
    )
    .all(fromRowid, since)
  let boosted = 0
  let edges = 0
  /** boost 水位：这三条查询覆盖同一窗口、无 LIMIT，可以推进到本轮最大。 */
  let nextRowid = fromRowid
  for (const row of rows) nextRowid = Math.max(nextRowid, Number(row.max_rowid) || 0)
  /** 边水位：只推进到「确实处理过的最后一批」，LIMIT 500 之外的留给下一轮。 */
  let nextEdgeRowid = fromEdgeRowid
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
        `SELECT ts, GROUP_CONCAT(unit_id) AS ids, MAX(rowid) AS max_rowid FROM recall_log
          WHERE rowid > ? AND ts >= ? AND rank <= 3 GROUP BY ts HAVING COUNT(*) > 1 ORDER BY ts ASC LIMIT 500`,
      )
      .all(fromEdgeRowid, since)
    for (const batch of batches) {
      // 只推进到确实处理过的最后一批；剩下的批次下一轮还能被查到
      nextEdgeRowid = Math.max(nextEdgeRowid, Number(batch.max_rowid) || 0)
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
    if (nextRowid > fromRowid) store.setMeta('evolve_reinforce_rowid', String(nextRowid))
    // 自愈：强化之后，把「importance 已达标却被归档」的矛盾态条目原地复活
    const revival = reviveArchivedBoosted({ store, config: cfg, now })
    // 边水位单独推进（见上方「两个独立水位」注释）：回滚则两个水位都不动 → 重试不会重复计价
    if (nextEdgeRowid > fromEdgeRowid) store.setMeta('evolve_edge_rowid', String(nextEdgeRowid))
    tx.exec('COMMIT')
    return { ok: true, step: 'reinforce', boosted, edges, revived: revival.revived, scanned: rows.length }
  } catch (error) {
    tx.exec('ROLLBACK')
    return { ok: false, step: 'reinforce', message: error.message }
  }
}

/**
 * 自愈误归档（2026-10-14）：把「按现行规则本不该被归档」的 archived 条目救回 active。
 *
 * 判据 A —— 强化矛盾态（t1）：`importance >= archiveBelow`。这是「强化」与「归档」互相打脸的
 * 产物（真实反例 id 312d0096：importance 1.0000 却 archived），必须原地复活。
 *
 * 判据 B —— 与 decay 判据对称（t8）：`access_count > 0` **且** changes 里有 decay 归档痕迹。
 * 由头：decay 的新规则说「被取回过的条目不归档」，但改动前已被旧规则判死的那批
 * （importance 已衰减到 0.104~0.139）按判据 A 救不回来，形成「新规则说不该归档、revive 却
 * 不肯救」的设计不一致。真实库副本实测：这批 143 条，其中 20 条正是标注集期望但被判死的。
 *
 * **区分归档来源（硬约束：不得复活用户的手动归档）**——真实库（991 条）里三种来源可判：
 *   ① decay 自动归档  → changes: {status:'archived', reason:'decay'}（182 条 / 175 unit）
 *   ② 面板/`mem_update --action archive` → changes: {status:'archived', pinned:null}（reason 缺失）
 *      或 {status:'archived', reason:'<人工写的迁移/去重说明>'}
 *   ③ legacy 导入      → 建库时即 status='archived'，**无任何 changes 痕迹**（origin='import'）
 * 判据 B 因此要求「有 status='archived' 且 reason='decay' 的 changes 记录」：
 * ② 无 reason 或 reason 是人话 → 排除；③ 无痕迹 → 排除。宁可少救，不可误救用户的显式意图。
 *
 * 仍然**不是删除**：只把 status 改回 active 并留 changes 痕迹（reason:'revive'）。
 */
export function reviveArchivedBoosted({ store, config = EVOLVE_DEFAULTS, now = Date.now() } = {}) {
  const cfg = { ...EVOLVE_DEFAULTS, ...config }
  if (cfg.reviveOnReinforce !== true) return { revived: 0, scanned: 0, skipped: 'reviveOnReinforce=false' }
  const floor = Number.isFinite(Number(cfg.archiveBelow)) ? Number(cfg.archiveBelow) : EVOLVE_DEFAULTS.archiveBelow
  const db = store.db

  // 归档来源判据之一：带 decay 痕迹的 unit（只有 evolution 的 decay 会这样记 changes）
  const decayTraced = new Set()
  if (cfg.reviveAccessCounted !== false) {
    for (const t of db
      .prepare(
        `SELECT DISTINCT entity_id AS id FROM changes
          WHERE entity = 'unit' AND op = 'status'
            AND json_extract(payload, '$.reason') = 'decay'
            AND json_extract(payload, '$.status') = 'archived'`,
      )
      .all()) {
      decayTraced.add(t.id)
    }
  }

  // 「用户显式归档」判据（唯一可靠痕迹：无 reason 或 reason 是人话的归档留痕）
  // 真实库实测：手动归档 = {status:'archived', pinned:null}（reason 缺失）或 reason 写成迁移/去重说明；
  // decay 自动归档 reason 恒为 'decay'。因此只认由非 'decay' 归档留痕的条目为用户意图，永久豁免自愈。
  const humanArchived = new Set()
  for (const t of db
    .prepare(
      `SELECT DISTINCT entity_id AS id FROM changes
        WHERE entity = 'unit' AND op = 'status'
          AND json_extract(payload, '$.status') = 'archived'
          AND COALESCE(json_extract(payload, '$.reason'), '(none)') <> 'decay'`,
    )
    .all()) {
    humanArchived.add(t.id)
  }

  // 「legacy 导入归档」判据：建库时即写入 status='archived'（MEMORY-archive.md / *-archive.md 的产物）。
  // 它们的唯一痕迹是插入时的 upsert{status:'archived'}；此后既无 status 留痕、也无 decay 证据，
  // 而 importance 是导入默认值（0.5 > 阈值）——不豁免就会被判据 A 无脑复活（单测已抓到该漏洞）。
  // 判据 = 仅一条 upsert 且其 status='archived'、且没有任何 status 留痕。
  const legacyArchived = new Set()
  for (const t of db
    .prepare(
      `SELECT entity_id AS id FROM changes
        WHERE entity = 'unit' AND op = 'upsert'
          AND json_extract(payload, '$.status') = 'archived'
          AND entity_id NOT IN (SELECT entity_id FROM changes WHERE entity = 'unit' AND op = 'status')
        GROUP BY entity_id
        HAVING COUNT(*) = 1`,
    )
    .all()) {
    legacyArchived.add(t.id)
  }

  const rows = db
    .prepare("SELECT id, importance, pinned, access_count, track, kind FROM units WHERE status = 'archived' AND (importance >= ? OR access_count > 0)")
    .all(floor)
  let revived = 0
  let byBoost = 0
  let bySymmetry = 0
  let sparedHuman = 0
  let sparedLegacy = 0
  let sparedTransient = 0
  for (const row of rows) {
    if (Number(row.pinned) === 1) continue
    // 硬约束：用户的显式归档与 legacy 导入的归档永不自愈（宁少救，不误救）
    if (humanArchived.has(row.id)) {
      sparedHuman += 1
      continue
    }
    if (legacyArchived.has(row.id)) {
      sparedLegacy += 1
      continue
    }
    const boosted = Number(row.importance) >= floor
    const symmetric = Number(row.access_count ?? 0) > 0 && decayTraced.has(row.id)
    // 可选的收窄：只救可沉淀轨（默认关，见 reviveDurableOnly 注释）
    if (cfg.reviveDurableOnly === true && (row.track === 'daily' || row.kind === 'progress')) {
      sparedTransient += 1
      continue
    }
    // 判据 A：importance 已达标（矛盾态）；判据 B：被取回过 + 确定带 decay 痕迹（历史误杀，判据与 decay 对称）
    if (!boosted && !symmetric) continue
    const info = db.prepare("UPDATE units SET status = 'active' WHERE id = ? AND status = 'archived'").run(row.id)
    if (Number(info.changes) === 0) continue
    store.logChange('unit', row.id, 'status', {
      status: 'active',
      reason: 'revive',
      importance: Number(row.importance),
      via: boosted ? 'importance' : 'access_count+decay-trace',
    })
    revived += 1
    if (boosted) byBoost += 1
    else bySymmetry += 1
  }
  return {
    revived,
    byBoost,
    bySymmetry,
    decayTraced: decayTraced.size,
    sparedHuman,
    sparedLegacy,
    sparedTransient,
    scanned: rows.length,
  }
}

/**
 * 衰减与归档：指数半衰期；低于阈值转 archived（可恢复，pin 豁免）。
 *
 * 止血（2026-10-14）：**被取回过的条目（access_count > 0）在本轮一律不归档**。
 * 起因是真实库复盘——eval 期望的 25 条里有 20 条是 archived，其 access_count
 * 高达 141~7505（明明被反复取回），却因 importance 衰减到 archiveBelow 以下被判死，
 * 命中率从 87.5% 掉到 16.7%。recency 只该是 ±10% 的排序信号，不该是删除决策：
 * 这类条目 importance 仍照常衰减（排序自然靠后），但不会消失。
 * 关掉该保护只需 config.decayAccessGrace = 0。
 */
export function decay({ store, config = EVOLVE_DEFAULTS, now = Date.now() } = {}) {
  const cfg = { ...EVOLVE_DEFAULTS, ...config }
  const rows = store.db.prepare("SELECT id, importance, pinned, access_count, last_accessed, updated_at, created_at FROM units WHERE status = 'active'").all()
  let decayed = 0
  let archived = 0
  let accessGuarded = 0
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
      // 取回宽限：被取回过的条目本轮不归档（importance 照样降，但记忆不消失）
      const accessed = Number(row.access_count ?? 0) > 0
      if (next < cfg.archiveBelow && accessed && Number(cfg.decayAccessGrace) > 0) {
        accessGuarded += 1
        continue
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
  return { ok: true, step: 'decay', decayed, archived, accessGuarded, scanned: rows.length }
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
  /**
   * 产物失效核对（P2）：只在后台巡演里跑，**advisory only** ——
   * 只往 meta 写 artifact_state，不改 importance / status / 不归档不删除。
   * 相对路径需要 cwd 才能解析；没有 artifactCwd 时只核对绝对路径与 ~/ 路径。
   */
  guard(() => ({ step: 'artifacts', ok: true, ...verifyArtifacts(store, { cwd: cfg.artifactCwd ?? null }) }))
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
