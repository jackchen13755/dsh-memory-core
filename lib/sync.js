/**
 * 跨设备同步（设计 §4.5）：**变更日志 + git**。
 *
 * 为什么是变更日志而不是同步 .md / .db：
 * - SQLite 是二进制事实源，无法三方合并；
 * - 于是把"历史"单独装进**每设备一个只追加文件** `changes/changes-<deviceId>.jsonl`——
 *   多设备各自追加自己的文件，**git 永不冲突**；git 只搬日志，不搬库。
 *
 * 合并语义：条目级 lamport 时钟 + **LWW**；**同 lamport 但内容不同 → 冲突双留**
 * （保留本地、另存对端版本为一条新条目 + `contradicts` 边 + 待确认建议），
 * 人工在 `mem review` / 面板里裁决，**绝不静默覆盖**。
 *
 * 收敛性：冲突副本的 id 由"内容 + 来源设备"确定性地推导，所以两台设备各自生成的
 * 副本 id 相同 → 双方状态最终一致（可重复导入，幂等）。
 *
 * **信任边界（2026-10-30 收紧，P0-2）**：本模块原先把 `changes/*.jsonl` 当**本机可信输入**、
 * 刻意不做内容筛查（理由：能改写该文件的人同样能直接改库）。但同步日志经 git 搬运，
 * 一旦走共享仓库或第三方日志，这个前提就不成立，而规则类条目会直接进常驻段（最高信任位置）。
 * 现在改为**只标记不拦截**：内容判 high → 写 `meta.quarantined`（不进自动注入，
 * `mem_search`/`mem_get` 仍可取回）；判 medium → 写 `meta.untrusted`。
 * 已经带过 `meta.scan` 的行不重扫（幂等）；远端合法写入不受影响。
 *
 * 文件行格式（一行一条，纯文本可读、可 diff）：
 * `{"seq":12,"device":"ab12cd34","entity":"unit","id":"…","op":"upsert","lamport":34,"at":…,"row":{…}}`
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveEntryId } from './paths.js'
import { classifyContent } from './writer.js'

/**
 * 一条待落库内容的「扫描后 meta」（P0-2 的唯一出口，`upsertRow` 与冲突双留共用）。
 *
 * 两条铁律：
 *   ① **不信任入站的 `meta.scan`**。`meta` 是本函数要防御的那一方提供的（远端 changes 行原样搬运），
 *      认它当"已扫描"凭据等于把防线交给攻击者 —— 一行 `"scan":{"level":"clean"}` 就能整段跳过扫描。
 *      内容就在手边，重算是确定性的、零 IO，所以**每次都算**。
 *   ② **人的决定单向优先**。人用 `dsh-mem unquarantine` 解除过（`scan.clearedFor` 记着当时的
 *      content_hash），且内容没变时，不得被对端一次 upsert 又标回隔离（`meta` 是 LWW 整列覆盖，
 *      不显式保留就会被静默回滚）。
 *
 * @returns {string|null} 要写进 `units.meta` 的 JSON 字符串
 */
function mergeScanMeta(content, incomingMeta, { localMeta = null, contentHash = null } = {}) {
  const parse = (raw) => {
    try {
      const v = raw ? (typeof raw === 'string' ? JSON.parse(raw) : { ...raw }) : {}
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {} // 坏 JSON 不连累落库
    }
  }
  const meta = parse(incomingMeta)
  const local = parse(localMeta)
  const text = String(content ?? '')
  if (!text.trim()) return incomingMeta === undefined ? null : incomingMeta

  const scan = classifyContent(text)
  // 入站自己声明的隔离也保留（并集，方向：更谨慎）
  const claimedQuarantine = meta.quarantined === true
  const cleared = local.scan && local.scan.clearedFor && contentHash && local.scan.clearedFor === contentHash ? local.scan : null

  if (cleared) {
    // 人已解除且内容未变：保持解除，但把本次判定留档（可审计）
    meta.scan = { ...scan, clearedAt: cleared.clearedAt ?? Date.now(), clearedFor: cleared.clearedFor, clearedBy: cleared.clearedBy ?? 'human' }
    delete meta.quarantined
    delete meta.untrusted
    return JSON.stringify(meta)
  }
  if (scan.level === 'high' || claimedQuarantine) {
    meta.scan = scan
    meta.quarantined = true
    return JSON.stringify(meta)
  }
  if (scan.level === 'medium') {
    meta.scan = scan
    meta.untrusted = true
    return JSON.stringify(meta)
  }
  return incomingMeta === undefined ? JSON.stringify(meta) : typeof incomingMeta === 'string' ? incomingMeta : JSON.stringify(meta)
}

/** 参与跨设备同步的实体。会话级派生态（nodes / node_edges）刻意不在此列。 */
export const ENTITIES = ['unit', 'todo', 'skill']
const FILE_PREFIX = 'changes-'

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

function fileFor(dir, device) {
  return join(dir, `${FILE_PREFIX}${device}.jsonl`)
}

/** 当前行的完整快照（导出用；行不存在 → 墓碑）。 */
function snapshotOf(store, entity, id) {
  if (entity === 'unit') {
    const row = store.db.prepare('SELECT * FROM units WHERE id = ?').get(id)
    return row ? { row, deleted: false } : { row: null, deleted: true }
  }
  if (entity === 'todo') {
    const row = store.db.prepare('SELECT * FROM todos WHERE id = ?').get(id)
    return row ? { row, deleted: false } : { row: null, deleted: true }
  }
  if (entity === 'skill') {
    const row = store.db.prepare('SELECT * FROM skills WHERE name = ?').get(id)
    return row ? { row, deleted: false } : { row: null, deleted: true }
  }
  return { row: null, deleted: true }
}

export class SyncEngine {
  constructor(store, { dir }) {
    this.store = store
    this.dir = dir
    this.device = store.device
  }

  /** 导出本设备的增量（自上次游标起）→ 追加进本设备文件。 */
  exportChanges({ limit = 5000 } = {}) {
    ensureDir(this.dir)
    const since = Number(this.store.getMeta('sync_export_seq', '0'))
    const rows = this.store.db
      .prepare('SELECT * FROM changes WHERE device = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(this.device, since, limit)
    if (rows.length === 0) return { ok: true, written: 0, file: fileFor(this.dir, this.device), cursor: since }

    const lines = []
    for (const change of rows) {
      const { row, deleted } = snapshotOf(this.store, change.entity, change.entity_id)
      lines.push(
        JSON.stringify({
          seq: change.seq,
          device: change.device,
          entity: change.entity,
          id: change.entity_id,
          op: deleted ? 'delete' : change.op,
          lamport: change.lamport,
          at: change.at,
          row: deleted ? null : row,
        }),
      )
    }
    appendFileSync(fileFor(this.dir, this.device), `${lines.join('\n')}\n`, 'utf8')
    this.store.setMeta('sync_export_seq', String(rows[rows.length - 1].seq))
    this.store.setMeta('sync_last_export_at', String(Date.now()))
    return {
      ok: true,
      written: rows.length,
      file: fileFor(this.dir, this.device),
      cursor: rows[rows.length - 1].seq,
    }
  }

  /** 读取其它设备的日志文件（自己的跳过）。 */
  readRemoteLines() {
    if (!existsSync(this.dir)) return []
    const out = []
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith('.jsonl')) continue
      const device = name.slice(FILE_PREFIX.length, -'.jsonl'.length)
      if (device === this.device) continue
      const text = readFileSync(join(this.dir, name), 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed)
          parsed.__file = name
          out.push(parsed)
        } catch {
          out.push({ __file: name, __bad: trimmed.slice(0, 200) })
        }
      }
    }
    return out
  }

  /**
   * 应用对端变更：lamport LWW；同 lamport 不同内容 → 冲突双留（确定性副本 id）。
   */
  importChanges() {
    const lines = this.readRemoteLines()
    const report = { ok: true, scanned: lines.length, applied: 0, skipped: 0, conflicts: 0, bad: 0, errored: 0, errors: [], touched: {} }
    let maxRemote = 0
    for (const line of lines) {
      // 逐行隔离：**一行坏掉绝不能中断整次导入**。否则抛出后剩余行不应用、lamport 不跟进，而那一行
      // 永远留在日志文件里 → 每次重导都抛 = 同步永久卡死，且没有任何报告留痕。坏行计数上报，继续。
      try {
        if (line.__bad) {
          report.bad += 1
          continue
        }
        if (!ENTITIES.includes(line.entity) || !line.id) {
          report.bad += 1
          continue
        }
        const local = snapshotOf(this.store, line.entity, line.id)
        const remoteLamport = Number(line.lamport ?? 0)
        if (remoteLamport > maxRemote) maxRemote = remoteLamport

        if (line.op === 'delete') {
          if (!local.row) {
            report.skipped += 1
            continue
          }
          const localLamport = Number(local.row.lamport ?? 0)
          if (remoteLamport > localLamport) {
            this.deleteRow(line.entity, line.id)
            report.applied += 1
            report.touched[line.entity] = (report.touched[line.entity] ?? 0) + 1
          } else report.skipped += 1
          continue
        }

        if (!line.row) {
          report.bad += 1
          continue
        }

        if (!local.row) {
          this.insertRow(line.entity, line.row)
          report.applied += 1
          report.touched[line.entity] = (report.touched[line.entity] ?? 0) + 1
          continue
        }

        const localLamport = Number(local.row.lamport ?? 0)
        if (remoteLamport > localLamport) {
          this.upsertRow(line.entity, line.row)
          report.applied += 1
          report.touched[line.entity] = (report.touched[line.entity] ?? 0) + 1
          continue
        }
        if (remoteLamport < localLamport) {
          report.skipped += 1
          continue
        }
        // 同 lamport：内容一致就是已收敛，不同才双留
        const same = line.entity === 'unit' ? local.row.content === line.row.content : JSON.stringify(local.row) === JSON.stringify(line.row)
        if (same) {
          report.skipped += 1
          continue
        }
        const conflicted = this.keepBoth(line)
        if (conflicted) {
          report.conflicts += 1
          report.touched[line.entity] = (report.touched[line.entity] ?? 0) + 1
        } else report.skipped += 1
      } catch (error) {
        report.errored += 1
        if (report.errors.length < 20) report.errors.push(`${line.entity ?? '?'} ${line.id ?? '?'}: ${error.message}`)
      }
    }
    // Lamport 规则：见过对端时钟后，本地时钟至少到那一步（后续本地编辑才不会"时钟落后"）。
    // 这一步与报告写入必须**无条件**执行（即使上面有坏行），否则时钟不跟进会导致后续所有导入都被
    // "本地 lamport 更大" 挡掉 —— 那是比单行失败严重得多的静默故障。失败也只记不抛。
    try {
      this.store.observeLamport(maxRemote)
    } catch (error) {
      report.errored += 1
      if (report.errors.length < 20) report.errors.push(`observeLamport: ${error.message}`)
    }
    this.store.setMeta('sync_last_import_at', String(Date.now()))
    this.store.setMeta('sync_last_import_report', JSON.stringify(report))
    return report
  }

  /** 双留：本地原样保留，对端版本另存为新条目（id 确定性推导 → 双方收敛）+ 冲突标记。 */
  keepBoth(line) {
    if (line.entity !== 'unit') {
      // 待办/技能：同 lamport 冲突时保留本地，仅记录（避免造出两条重复待办）
      this.store.insertSuggestion({
        kind: 'memory',
        target: 'memory',
        payload: {
          content: `同步冲突（${line.entity} ${line.id}）：对端设备 ${line.device} 有同版本不同内容，已保留本地版本。`,
          track: 'memory',
          reason: 'sync-conflict',
        },
      })
      return false
    }
    const remote = line.row
    // 只由内容推导（不含设备）→ 两台设备各自生成的副本集合一致，可重复导入且幂等
    const copyId = deriveEntryId('sync', String(remote.content ?? ''))
    const exists = this.store.db.prepare('SELECT id FROM units WHERE id = ?').get(copyId)
    if (!exists) {
      const now = Date.now()
      /**
       * 冲突双留是 `unit` 的**第四条落库路径**（前三条：`store.insertUnit`、`store.updateUnit`、
       * 本文件的 `upsertRow`）。它过去既不过扫描、也不写 `origin`，于是：
       * ① high 内容能借"同 lamport 不同内容"这条纯正常路径进常驻段；
       * ② `origin=NULL` → 渲染成 `agent`（看起来像本机工具直写），来源标记说谎。
       * 两处都在这里补齐 —— 新增写入口必须走同一个出口。
       */
      const copyMeta = mergeScanMeta(remote.content, JSON.stringify({ ...(safeJson(remote.meta) ?? {}), syncConflictWith: line.id, syncConflictDevice: line.device }), { contentHash: remote.content_hash })
      this.store.db
        .prepare(
          `INSERT INTO units (id, track, scope, kind, content, tokens, content_hash, meta, day, ord, source_file, created_at, updated_at, importance, pinned, status, version, lamport, occurred_at, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)`,
        )
        .run(
          copyId,
          remote.track,
          remote.scope,
          remote.kind ?? null,
          remote.content,
          remote.tokens ?? '',
          remote.content_hash ?? '',
          copyMeta,
          remote.day ?? null,
          `sync:${line.device}`,
          Number(remote.created_at ?? now),
          now,
          Number(remote.importance ?? 0.5),
          Number(remote.version ?? 1),
          Number(line.lamport ?? 0),
          remote.occurred_at ?? null,
          `sync:${line.device}`,
        )
      this.store.db
        .prepare('INSERT INTO units_fts (rowid, content, tokens) SELECT rowid, content, tokens FROM units WHERE id = ?')
        .run(copyId)
      this.store.db
        .prepare('INSERT OR REPLACE INTO edges (from_id, to_id, kind, weight) VALUES (?, ?, ?, ?)')
        .run(line.id, copyId, 'contradicts', 1)
      this.store.logChange('unit', copyId, 'upsert', { track: remote.track, content: remote.content, via: `sync:${line.device}` })
    }
    this.store.insertSuggestion({
      kind: 'memory',
      target: 'memory',
      payload: {
        content: `同步冲突：[${line.id}] 与 [${copyId}] 是同一件事的两个版本（设备 ${line.device}），请保留其一、归档另一条。`,
        track: 'memory',
        reason: 'sync-conflict',
      },
    })
    this.store.setMeta('sync_conflict_count', String(Number(this.store.getMeta('sync_conflict_count', '0')) + 1))
    return true
  }

  insertRow(entity, row) {
    this.upsertRow(entity, row)
  }

  upsertRow(entity, row) {
    if (entity === 'unit') {
      const cols = ['id', 'track', 'scope', 'kind', 'content', 'tokens', 'content_hash', 'meta', 'day', 'created_at', 'updated_at', 'importance', 'pinned', 'status', 'version', 'lamport', 'occurred_at']
      // 导入侧补扫（P0-2）：唯一出口见 mergeScanMeta（**不信任入站 meta.scan**）
      const local = this.store.db.prepare('SELECT meta, content_hash FROM units WHERE id = ?').get(row.id)
      const metaValue = mergeScanMeta(row.content, row.meta, { localMeta: local?.meta, contentHash: row.content_hash ?? local?.content_hash })
      const values = cols.map((c) => (c === 'meta' ? metaValue : row[c] === undefined ? null : row[c]))
      const placeholders = cols.map(() => '?').join(', ')
      // ① `units_content_hash (content_hash, track, scope)` 是**唯一索引**：同一个「内容 + 轨 + 域」只允许一行。
      //    旧的 `INSERT OR REPLACE` 靠隐式删除挡路的行来兜底；改用 `ON CONFLICT(id)` 之后这条冲突**不再被兜**
      //    （id 不冲突 → 直接抛 UNIQUE constraint failed），而导入循环若没有逐行兜底就会整次中断、且那一行
      //    永远留在日志文件里 → 每次重导都抛 = 同步永久卡死。这里把那个隐式行为**显式**做掉，
      //    并顺手清掉被顶掉那行的 FTS 行（REPLACE 会留下孤儿索引行）。
      const clash = this.store.db
        .prepare('SELECT id, rowid FROM units WHERE content_hash = ? AND track = ? AND scope = ? AND id <> ?')
        .get(row.content_hash ?? '', row.track ?? null, row.scope ?? null, row.id)
      if (clash) {
        this.store.db.prepare('DELETE FROM units_fts WHERE rowid = ?').run(clash.rowid)
        this.store.db.prepare('DELETE FROM units WHERE id = ?').run(clash.id)
      }
      // ② 旧 FTS 行按 rowid 先清：ON CONFLICT DO UPDATE 保留 rowid（与 store 同款维护，不再换 rowid）
      const before = this.store.db.prepare('SELECT rowid FROM units WHERE id = ?').get(row.id)
      if (before) this.store.db.prepare('DELETE FROM units_fts WHERE rowid = ?').run(before.rowid)
      // ③ occurred_at 只在**日志行缺这个键**（对端是旧版本）时才 COALESCE 兜底；键在就照原值走 ——
      //    包括「键在且为 null」（对端显式清空时间），否则清空永远传播不出去，两端各留一个时间。
      const hasOccurred = row.occurred_at !== undefined
      const updates = cols
        .filter((c) => c !== 'id')
        .map((c) => (c === 'occurred_at' && !hasOccurred ? `${c} = COALESCE(excluded.${c}, units.${c})` : `${c} = excluded.${c}`))
        .join(', ')
      this.store.db
        .prepare(`INSERT INTO units (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`)
        .run(...values)
      this.store.db
        .prepare('INSERT INTO units_fts (rowid, content, tokens) SELECT rowid, content, tokens FROM units WHERE id = ?')
        .run(row.id)
      return
    }
    if (entity === 'todo') {
      const cols = ['id', 'track', 'scope', 'day', 'content', 'quadrant', 'due', 'status', 'category', 'important', 'urgent', 'created_at', 'updated_at', 'done_at', 'lamport']
      const values = cols.map((c) => (row[c] === undefined ? null : row[c]))
      this.store.db
        .prepare(`INSERT OR REPLACE INTO todos (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...values)
      return
    }
    if (entity === 'skill') {
      const cols = ['name', 'path', 'source', 'description', 'enabled', 'hash', 'bytes', 'updated_at']
      const values = cols.map((c) => (row[c] === undefined ? null : row[c]))
      this.store.db
        .prepare(`INSERT OR REPLACE INTO skills (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...values)
    }
  }

  deleteRow(entity, id) {
    if (entity === 'unit') {
      // FTS 行必须**先按 rowid 删**：units_fts 是普通 fts5 表（列只有 content/tokens，没有 id 列），
      // 而 units 行删掉之后就查不到 rowid 了 —— 顺序反了会抛 no such column: id，并留下孤儿索引行。
      this.store.db.prepare('DELETE FROM units_fts WHERE rowid = (SELECT rowid FROM units WHERE id = ?)').run(id)
      this.store.db.prepare('DELETE FROM units WHERE id = ?').run(id)
    } else if (entity === 'todo') this.store.db.prepare('DELETE FROM todos WHERE id = ?').run(id)
    else if (entity === 'skill') this.store.db.prepare('DELETE FROM skills WHERE name = ?').run(id)
  }

  status() {
    const files = existsSync(this.dir)
      ? readdirSync(this.dir)
          .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith('.jsonl'))
          .map((n) => {
            const device = n.slice(FILE_PREFIX.length, -'.jsonl'.length)
            const text = readFileSync(join(this.dir, n), 'utf8')
            const lines = text.split('\n').filter((l) => l.trim())
            return { device, file: n, lines: lines.length, bytes: Buffer.byteLength(text), mine: device === this.device }
          })
      : []
    return {
      dir: this.dir,
      device: this.device,
      lamport: Number(this.store.lamport),
      exportCursor: Number(this.store.getMeta('sync_export_seq', '0')),
      pendingExport: this.store.db.prepare('SELECT COUNT(*) AS n FROM changes WHERE device = ? AND seq > ?').get(this.device, Number(this.store.getMeta('sync_export_seq', '0'))).n,
      conflicts: Number(this.store.getMeta('sync_conflict_count', '0')),
      lastExportAt: this.store.getMeta('sync_last_export_at', null),
      lastImportAt: this.store.getMeta('sync_last_import_at', null),
      files,
    }
  }
}

function safeJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
