/**
 * 存储层：units / todos / suggestions / skills / changes 的统一写入口（设计 §4、§5）。
 *
 * 约定：
 *   - 一切写入走单写者队列（`WriteQueue`），事务内完成；
 *   - 每次写入同步维护 FTS5 行与 `changes`（同步日志），并推进 lamport 时钟；
 *   - 普通写入默认 `record: true`：进变更日志，作为跨设备同步的载体；
 *     **导入基线**（legacy/快照回灌）显式传 `record: false`，否则会把历史重放成刚发生的变更。
 */
import { deviceId, getMeta, setMeta } from './db.js'
import { deriveEntryId, sha1 } from './paths.js'
import { tokensField } from './tokens.js'

const FTS_INSERT = `
  INSERT INTO units_fts (rowid, content, tokens)
  SELECT rowid, content, tokens FROM units WHERE id = ?
`

export class Store {
  constructor(db, { device = null } = {}) {
    this.db = db
    this.device = device ?? deviceId(db)
    const row = db.prepare('SELECT COALESCE(MAX(lamport), 0) AS m FROM changes').get()
    this.lamport = Number(row?.m ?? 0)
  }

  tick() {
    this.lamport += 1
    setMeta(this.db, 'lamport', String(this.lamport))
    return this.lamport
  }

  /**
   * 观测远端时钟（Lamport 规则）：本地时钟至少不低于见过的最大值。
   * 少了这一步，**只导入不写入**的设备会拿着过小的时钟去改条目，
   * 于是"更晚的本地编辑"在 LWW 里反而输给对端——冲突也会被误判成旧值。
   */
  observeLamport(remote) {
    const n = Number(remote ?? 0)
    if (n > this.lamport) {
      this.lamport = n
      setMeta(this.db, 'lamport', String(this.lamport))
    }
    return this.lamport
  }

  // --- meta / projects -----------------------------------------------------

  getMeta(key, fallback = null) {
    return getMeta(this.db, key, fallback)
  }

  setMeta(key, value) {
    setMeta(this.db, key, value)
  }

  putProject({ hash, cwd = null, remote = null, label = null }) {
    this.db
      .prepare(
        `INSERT INTO projects (hash, cwd, remote, label, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
           cwd = COALESCE(excluded.cwd, projects.cwd),
           remote = COALESCE(excluded.remote, projects.remote),
           label = COALESCE(excluded.label, projects.label),
           updated_at = excluded.updated_at`,
      )
      .run(hash, cwd, remote, label, Date.now())
  }

  listProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY hash').all()
  }

  // --- units ---------------------------------------------------------------

  /**
   * 写入一条记忆单元（幂等：同 track/scope/content 已存在则跳过）。
   * @returns {{ id: string, inserted: boolean }}
   */
  insertUnit(
    {
      id = null,
      track,
      scope,
      kind = null,
      content,
      meta = null,
      day = null,
      ord = null,
      sourceFile = null,
      createdAt = null,
      gitBranch = null,
      importance = 0.5,
      pinned = 0,
      status = 'active',
      origin = 'import',
    },
    { record = true } = {}, // 普通写入一律记变更日志（同步载体）；导入基线显式传 record:false
  ) {
    const text = String(content ?? '').trim()
    if (!text) return { id: null, inserted: false }
    const hash = sha1(text)
    const existing = this.db
      .prepare('SELECT id FROM units WHERE content_hash = ? AND track = ? AND scope = ?')
      .get(hash, track, scope)
    if (existing) return { id: existing.id, inserted: false }

    const entryId = id ?? deriveEntryId(track, scope, text)
    const ts = createdAt ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO units (id, track, scope, kind, content, tokens, content_hash, meta, day, ord, source_file,
                            created_at, updated_at, git_branch, importance, pinned, status, origin, lamport)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryId,
        track,
        scope,
        kind,
        text,
        tokensField(text),
        hash,
        meta ? JSON.stringify(meta) : null,
        day,
        ord,
        sourceFile,
        ts,
        ts,
        gitBranch,
        importance,
        pinned,
        status,
        origin,
        record ? this.tick() : 0,
      )
    this.db.prepare(FTS_INSERT).run(entryId)
    if (record) {
      this.logChange('unit', entryId, 'upsert', { track, scope, kind, content: text, status })
    }
    return { id: entryId, inserted: true }
  }

  /** 修改一条记忆：version++ → 旧版本进 `unit_history` → 重算 FTS → 记 changes。 */
  updateUnit(id, { content, kind, meta, track, importance, status, reason = null, editedBy = 'user' }) {
    const row = this.db.prepare('SELECT * FROM units WHERE id = ?').get(id)
    if (!row) return { ok: false, message: `未找到条目 ${id}` }
    const nextContent = content !== undefined ? String(content).trim() : row.content
    const nextVersion = row.version + 1
    const lamport = this.tick()

    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO unit_history (id, version, content, meta, track, kind, edited_by, edited_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, row.version, row.content, row.meta, row.track, row.kind, editedBy, Date.now(), reason)
      this.db
        .prepare(
          `UPDATE units SET content = ?, content_hash = ?, tokens = ?, kind = COALESCE(?, kind),
                            meta = COALESCE(?, meta), track = COALESCE(?, track),
                            importance = COALESCE(?, importance), status = COALESCE(?, status),
                            version = ?, updated_at = ?, lamport = ? WHERE id = ?`,
        )
        .run(
          nextContent,
          sha1(nextContent),
          tokensField(nextContent),
          kind ?? null,
          meta !== undefined ? JSON.stringify(meta) : null,
          track ?? null,
          importance ?? null,
          status ?? null,
          nextVersion,
          Date.now(),
          lamport,
          id,
        )
      this.db.prepare('DELETE FROM units_fts WHERE rowid = (SELECT rowid FROM units WHERE id = ?)').run(id)
      this.db.prepare(FTS_INSERT).run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, message: error.message }
    }
    this.logChange('unit', id, 'upsert', { track: track ?? row.track, content: nextContent, version: nextVersion })
    return { ok: true, id, version: nextVersion }
  }

  getUnit(id) {
    const row = this.db.prepare('SELECT * FROM units WHERE id = ?').get(id)
    return row ?? null
  }

  /** 廉价的变更戳（条数 + 最新更新时间 + rowid 上界）：用于语料/常驻段的缓存失效判断。 */
  stamp() {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m, COALESCE(MAX(updated_at), 0) AS t FROM units')
      .get()
    return `${row.n}:${row.m}:${row.t}`
  }

  listUnits({ track = null, scope = null, status = 'active', limit = 200, offset = 0 } = {}) {
    const where = []
    const args = []
    if (track) (where.push('track = ?'), args.push(track))
    if (scope) (where.push('scope = ?'), args.push(scope))
    if (status) (where.push('status = ?'), args.push(status))
    const sql = `SELECT * FROM units ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT ? OFFSET ?`
    return this.db.prepare(sql).all(...args, limit, offset)
  }

  // --- todos ---------------------------------------------------------------

  insertTodo(todo) {
    const id = todo.id ?? deriveEntryId('todo', todo.track, todo.content)
    const exists = this.db.prepare('SELECT id FROM todos WHERE id = ?').get(id)
    if (exists) return { id, inserted: false }
    const ts = todo.createdAt ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO todos (id, track, scope, day, content, quadrant, due, status, category,
                            important, urgent, created_at, updated_at, done_at, origin, lamport)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        todo.track,
        todo.scope ?? null,
        todo.day ?? null,
        todo.content,
        todo.quadrant ?? null,
        todo.due ?? null,
        todo.status ?? 'pending',
        todo.category ?? null,
        todo.important ?? null,
        todo.urgent ?? null,
        ts,
        ts,
        todo.doneAt ? Date.parse(todo.doneAt) || null : null,
        todo.origin ?? 'import',
        todo.record ? this.tick() : 0,
      )
    if (todo.record) this.logChange('todo', id, 'upsert', todo)
    return { id, inserted: true }
  }

  listTodos({ track = null, scope = null, status = null, day = null, limit = 500 } = {}) {
    const where = []
    const args = []
    if (track) (where.push('track = ?'), args.push(track))
    if (scope) (where.push('scope = ?'), args.push(scope))
    if (status) (where.push('status = ?'), args.push(status))
    if (day) (where.push('day = ?'), args.push(day))
    const sql = `SELECT * FROM todos ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
    return this.db.prepare(sql).all(...args, limit)
  }

  // --- suggestions ---------------------------------------------------------

  insertSuggestion({ id = null, kind, target = null, payload, sessionId = null, createdAt = null, status = 'pending' }) {
    const sid = id ?? deriveEntryId('suggestion', kind, JSON.stringify(payload ?? {}), String(createdAt ?? ''))
    const exists = this.db.prepare('SELECT id FROM suggestions WHERE id = ?').get(sid)
    if (exists) return { id: sid, inserted: false }
    this.db
      .prepare(
        `INSERT INTO suggestions (id, kind, target, payload, session_id, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sid, kind, target, JSON.stringify(payload ?? {}), sessionId, createdAt ?? Date.now(), status)
    return { id: sid, inserted: true }
  }

  /**
   * 列建议。`sessionId` 给定时只看该会话的产物（面板"本会话"视图）；
   * 传 `'all'` 或省略则不按会话过滤。`'orphan'` 只看没有会话归属的历史数据。
   */
  listSuggestions({ status = 'pending', kind = null, sessionId = null, limit = 200 } = {}) {
    const where = ['status = ?']
    const args = [status]
    if (kind) (where.push('kind = ?'), args.push(kind))
    if (sessionId && sessionId !== 'all') {
      if (sessionId === 'orphan') where.push('session_id IS NULL')
      else (where.push('session_id = ?'), args.push(sessionId))
    }
    return this.db.prepare(`SELECT * FROM suggestions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...args, limit)
  }

  /**
   * 回填建议归属会话（历史数据修复，幂等）。
   * 早期 `writeMemory` 没把 sessionId 传给建议，但 payload.origin 里写着 `extract:<会话>`，
   * 用它把 session_id 补回来，面板才能按会话区分待确认。
   */
  backfillSuggestionSessions() {
    const rows = this.db.prepare("SELECT id, payload FROM suggestions WHERE session_id IS NULL OR session_id = ''").all()
    let fixed = 0
    const upd = this.db.prepare('UPDATE suggestions SET session_id = ? WHERE id = ?')
    for (const row of rows) {
      let origin = null
      try {
        origin = JSON.parse(row.payload)?.origin ?? null
      } catch {
        origin = null
      }
      const m = /^extract:(.+)$/.exec(String(origin ?? ''))
      if (!m || !m[1] || m[1] === 'session') continue
      upd.run(m[1], row.id)
      fixed += 1
    }
    return fixed
  }

  // --- skills --------------------------------------------------------------

  upsertSkill({ name, path, source = 'user', description = null, enabled = 1, hash = null, bytes = null, updatedAt = null }) {
    this.db
      .prepare(
        `INSERT INTO skills (name, path, source, description, enabled, hash, bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path, source = excluded.source, description = excluded.description,
           enabled = excluded.enabled, hash = excluded.hash, bytes = excluded.bytes,
           updated_at = excluded.updated_at`,
      )
      .run(name, path, source, description, enabled, hash, bytes, updatedAt ?? Date.now())
  }

  listSkills({ enabled = null } = {}) {
    // 排序统一为「最新在上」：按最后更新时间倒序（同刻再按名字）
    if (enabled === null) return this.db.prepare('SELECT * FROM skills ORDER BY updated_at DESC, name').all()
    return this.db.prepare('SELECT * FROM skills WHERE enabled = ? ORDER BY updated_at DESC, name').all(enabled ? 1 : 0)
  }

  // --- changes / stats -----------------------------------------------------

  logChange(entity, entityId, op, payload) {
    this.db
      .prepare('INSERT INTO changes (entity, entity_id, op, payload, device, lamport, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entity, entityId, op, JSON.stringify(payload ?? {}), this.device, this.lamport, Date.now())
  }

  counts() {
    const one = (sql, ...args) => Number(this.db.prepare(sql).get(...args)?.n ?? 0)
    const byTrack = {}
    for (const row of this.db.prepare('SELECT track, COUNT(*) AS n FROM units GROUP BY track').all()) {
      byTrack[row.track] = Number(row.n)
    }
    return {
      units: one('SELECT COUNT(*) AS n FROM units'),
      unitsActive: one("SELECT COUNT(*) AS n FROM units WHERE status = 'active'"),
      byTrack,
      fts: one('SELECT COUNT(*) AS n FROM units_fts'),
      todos: one('SELECT COUNT(*) AS n FROM todos'),
      suggestions: one('SELECT COUNT(*) AS n FROM suggestions'),
      skills: one('SELECT COUNT(*) AS n FROM skills'),
      projects: one('SELECT COUNT(*) AS n FROM projects'),
      history: one('SELECT COUNT(*) AS n FROM unit_history'),
      changes: one('SELECT COUNT(*) AS n FROM changes'),
    }
  }
}
