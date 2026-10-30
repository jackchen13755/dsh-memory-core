/**
 * 存量补扫（P0-2 的回填路径，`dsh-mem rescan`）。
 *
 * 为什么需要它：`classifyContent` 只挂在**新落库**的路径上（写入、导入、同步）。
 * 对已经有数据的库（本机 945 条 active，其中 `origin='import'` 的旧语料占大头），
 * 补扫永远不会被触发 —— 也就是说「读入侧真空」对历史数据仍然敞着。
 * 这条命令把判定跑一遍现有条目，把结果写进 `units.meta`（`scan` / `quarantined` / `untrusted`）。
 *
 * 三条纪律：
 *   1. **只标记不删除**：隔离只影响自动注入，`mem_search` / `mem_get` 仍可取回；
 *   2. **人的决定单向优先**：`meta.scan.clearedFor === content_hash` 表示人解除过且内容未变
 *      → 不重新隔离（只更新 scan 留档）；
 *   3. **不写 changes 日志**：这是本机维护动作，不是内容变更，不该同步到别的设备、
 *      也不该把 `updated_at` 变成"刚改过"（那会让语料版本戳抖动一次，代价可接受但无收益）。
 */
import { classifyContent } from './writer.js'

/**
 * @param {import('./store.js').Store} store
 * @param {{ dryRun?: boolean, limit?: number }} [opts]
 * @returns {{ total: number, scanned: number, clean: number, medium: number, high: number,
 *             quarantined: number, keptCleared: number, changed: number, dryRun: boolean }}
 */
export function rescanUnits(store, { dryRun = false, limit = 0 } = {}) {
  const rows = store.db.prepare("SELECT id, content, meta, content_hash FROM units WHERE status = 'active' ORDER BY updated_at DESC").all()
  const capped = Number(limit) > 0 ? rows.slice(0, Number(limit)) : rows
  const stats = { total: rows.length, scanned: 0, clean: 0, medium: 0, high: 0, quarantined: 0, keptCleared: 0, changed: 0, dryRun: Boolean(dryRun) }
  const stmt = dryRun ? null : store.db.prepare('UPDATE units SET meta = ? WHERE id = ?')

  for (const row of capped) {
    let meta = {}
    try {
      meta = row.meta ? JSON.parse(row.meta) : {}
    } catch {
      meta = {}
    }
    if (!meta || typeof meta !== 'object') meta = {}

    const scan = classifyContent(row.content)
    stats.scanned += 1
    if (scan.level === 'high') stats.high += 1
    else if (scan.level === 'medium') stats.medium += 1
    else stats.clean += 1

    // 人解除过且内容未变 → 保持解除（单向优先），只更新留档
    const cleared = meta.scan && meta.scan.clearedFor && meta.scan.clearedFor === row.content_hash ? meta.scan : null
    const next = { ...meta }
    if (cleared) {
      next.scan = { ...scan, clearedAt: cleared.clearedAt ?? Date.now(), clearedFor: cleared.clearedFor, clearedBy: cleared.clearedBy ?? 'human' }
      delete next.quarantined
      delete next.untrusted
      stats.keptCleared += 1
    } else if (scan.level === 'high') {
      next.scan = scan
      next.quarantined = true
    } else if (scan.level === 'medium') {
      next.scan = scan
      next.untrusted = true
    } else if (meta.quarantined !== true) {
      // clean 且原本没隔离：不写（避免给每行加几十字节的留档，白占同步带宽）
      continue
    }
    // clean 但原本 quarantined：可能是误判过；交给人工决定，这里不动它（只更新 scan 事实）
    else {
      next.scan = scan
    }

    if (next.quarantined === true) stats.quarantined += 1
    const after = JSON.stringify(next)
    if (after === JSON.stringify(meta)) continue
    stats.changed += 1
    if (stmt) stmt.run(after, row.id)
  }
  // 只改 meta、不 bump updated_at ⇒ 必须推纪元，否则运行中的进程看不到（见 store.bumpMetaEpoch）
  if (!dryRun && stats.changed > 0) store.bumpMetaEpoch()
  return stats
}
