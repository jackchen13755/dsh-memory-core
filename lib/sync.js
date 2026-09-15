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
 * 文件行格式（一行一条，纯文本可读、可 diff）：
 * `{"seq":12,"device":"ab12cd34","entity":"unit","id":"…","op":"upsert","lamport":34,"at":…,"row":{…}}`
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveEntryId } from './paths.js'

const ENTITIES = ['unit', 'todo', 'skill']
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
    const report = { ok: true, scanned: lines.length, applied: 0, skipped: 0, conflicts: 0, bad: 0, touched: {} }
    let maxRemote = 0
    for (const line of lines) {
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
    }
    // Lamport 规则：见过对端时钟后，本地时钟至少到那一步（后续本地编辑才不会"时钟落后"）
    this.store.observeLamport(maxRemote)
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
      this.store.db
        .prepare(
          `INSERT INTO units (id, track, scope, kind, content, tokens, content_hash, meta, day, ord, source_file, created_at, updated_at, importance, pinned, status, version, lamport)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, 'active', ?, ?)`,
        )
        .run(
          copyId,
          remote.track,
          remote.scope,
          remote.kind ?? null,
          remote.content,
          remote.tokens ?? '',
          remote.content_hash ?? '',
          JSON.stringify({ ...(safeJson(remote.meta) ?? {}), syncConflictWith: line.id, syncConflictDevice: line.device }),
          remote.day ?? null,
          `sync:${line.device}`,
          Number(remote.created_at ?? now),
          now,
          Number(remote.importance ?? 0.5),
          Number(remote.version ?? 1),
          Number(line.lamport ?? 0),
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
      const cols = ['id', 'track', 'scope', 'kind', 'content', 'tokens', 'content_hash', 'meta', 'day', 'created_at', 'updated_at', 'importance', 'pinned', 'status', 'version', 'lamport']
      const values = cols.map((c) => (row[c] === undefined ? null : row[c]))
      const placeholders = cols.map(() => '?').join(', ')
      // INSERT OR REPLACE 会换掉 rowid → 先清旧 FTS 行，再按新 rowid 挂上（与 store 同款维护）
      const before = this.store.db.prepare('SELECT rowid FROM units WHERE id = ?').get(row.id)
      if (before) this.store.db.prepare('DELETE FROM units_fts WHERE rowid = ?').run(before.rowid)
      this.store.db.prepare(`INSERT OR REPLACE INTO units (${cols.join(', ')}) VALUES (${placeholders})`).run(...values)
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
      this.store.db.prepare('DELETE FROM units WHERE id = ?').run(id)
      this.store.db.prepare('DELETE FROM units_fts WHERE id = ?').run(id)
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
