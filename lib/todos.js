/**
 * 待办模块（设计 §9）：四轨（生活 / 工作 / 项目按 cwd / 每日按日期）。
 *
 * 与旧插件（dsh-memory-evolve 的 dtodo）保持**动作词汇与视图语义一致**，便于
 * 工作流平迁：`add / list / done / update / remove`，list 默认给"需要关注"的
 * 智能视图（逾期 + 今日到期 + 当前项目 + 重要紧急，最多 8 条），看全部要显式 `all`。
 *
 * 落盘格式沿用旧插件（`[时间] [id: xxxx] [q1] [due: …] [status: …] [cat: …]` + 内容，§ 分隔），
 * 因为 Markdown 快照是"给人看/给 grep 用"的那一层，格式一致才能和旧库无缝对照。
 */
import { projectHash } from './paths.js'
import { deriveEntryId } from './paths.js'

export const TRACKS = ['life', 'work', 'project', 'daily']
export const STATUSES = ['pending', 'doing', 'done', 'blocked', 'cancelled']
const QUADRANTS = new Set(['q1', 'q2', 'q3', 'q4'])

function today(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function quadrantOf({ quadrant, important, urgent }) {
  if (quadrant && QUADRANTS.has(quadrant)) return quadrant
  const i = important === true || important === 1
  const u = urgent === true || urgent === 1
  return i && u ? 'q1' : i ? 'q2' : u ? 'q3' : 'q4'
}

export class TodoManager {
  constructor(store) {
    this.store = store
    this.db = store.db
  }

  /** 解析轨道与作用域（项目轨按 cwd 隔离；每日轨带日期）。 */
  resolveScope({ track, cwd = null, date = null, scope = null }) {
    if (scope) return { scope, day: track === 'daily' ? (date ?? today()) : date }
    if (track === 'project') return { scope: cwd ? `project:${projectHash(cwd)}` : 'global', day: date }
    if (track === 'daily') return { scope: 'global', day: date ?? today() }
    return { scope: 'global', day: date }
  }

  /**
   * 新增待办。模型自建时走 `suggest`（进待确认队列），用户口述直接 add。
   */
  add({ content, track = 'work', quadrant, important, urgent, due = null, category = null, status = 'pending', cwd = null, date = null, scope = null, origin = 'user' }) {
    const text = String(content ?? '').trim()
    if (!text) return { ok: false, message: '内容不能为空' }
    if (!TRACKS.includes(track)) return { ok: false, message: `未知轨道 ${track}（可选 ${TRACKS.join('/')}）` }
    if (status && !STATUSES.includes(status)) return { ok: false, message: `未知状态 ${status}` }
    const resolved = this.resolveScope({ track, cwd, date, scope })
    const id = deriveEntryId('todo', track, resolved.scope, resolved.day ?? '', text)
    const exists = this.db.prepare('SELECT id FROM todos WHERE id = ?').get(id)
    if (exists) return { ok: false, message: '已存在同一条待办', id }
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO todos (id, track, scope, day, content, quadrant, due, status, category, important, urgent, created_at, updated_at, origin, lamport)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        track,
        resolved.scope,
        resolved.day ?? null,
        text,
        quadrantOf({ quadrant, important, urgent }),
        due,
        status,
        category,
        important === true ? 1 : important === false ? 0 : null,
        urgent === true ? 1 : urgent === false ? 0 : null,
        now,
        now,
        origin,
        this.store.lamport + 1,
      )
    this.store.logChange('todo', id, 'upsert', { track, scope: resolved.scope, content: text, status })
    return { ok: true, id, track, scope: resolved.scope, day: resolved.day ?? null }
  }

  /** 模型自建 → 待确认队列（与记忆提取同一套确认制）。 */
  suggest({ content, track = 'work', due = null, cwd = null, sessionId = null, reason = '模型建议的待办' }) {
    const text = String(content ?? '').trim()
    if (!text) return { ok: false, message: '内容不能为空' }
    const resolved = this.resolveScope({ track, cwd })
    const { id, inserted } = this.store.insertSuggestion({
      kind: 'todo',
      target: track,
      payload: { content: text, track, scope: resolved.scope, due, reason },
      sessionId,
    })
    return { ok: true, id, inserted, status: inserted ? 'queued' : 'queued-duplicate' }
  }

  get(id) {
    return this.db.prepare('SELECT * FROM todos WHERE id = ?').get(String(id)) ?? null
  }

  /**
   * 列表。默认**智能视图**：逾期 + 今日到期 + 当前项目 + 重要紧急（并集，最多 8 条）；
   * `all=true` 返回未过滤；`past=true` 附带每日轨过往（`expired=true` 才含过期遗留）。
   */
  /** `scope` 显式给出项目作用域（面板按会话解析）；否则由 `cwd` 推导。 */
  list({ track = null, scope = null, cwd = null, day = null, status = null, all = false, past = false, expired = false, limit = 500, now = Date.now() } = {}) {
    const todayStr = today(now)
    const where = []
    const args = []
    if (track) (where.push('track = ?'), args.push(track))
    if (scope) (where.push('scope = ?'), args.push(scope))
    if (day) (where.push('day = ?'), args.push(day))
    if (status) (where.push('status = ?'), args.push(status))
    if (!all && !status) where.push("status IN ('pending','doing','blocked')")
    const rows = this.db
      .prepare(`SELECT * FROM todos ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(due, '9999') ASC, created_at DESC LIMIT ?`)
      .all(...args, limit)

    if (all) return rows

    const projectScope = scope ?? (cwd ? `project:${projectHash(cwd)}` : null)
    const scored = rows.filter((row) => {
      const overdue = row.due && row.due < todayStr
      const dueToday = row.due === todayStr
      const mine = projectScope ? row.scope === projectScope : false
      const hot = row.quadrant === 'q1'
      const isDaily = row.track === 'daily'
      const isPastDaily = isDaily && row.day && row.day < todayStr
      if (isPastDaily) {
        // 过往每日待办：默认只在过期遗留（expired）或显式 past 时出现
        if (!past) return false
        if (row.status !== 'pending' && row.status !== 'doing') return false
        return expired ? true : false
      }
      return Boolean(overdue || dueToday || mine || hot)
    })
    return scored.slice(0, 8)
  }

  /** 收尾/常驻段用的一行提醒（只报条数，不注入内容）。 */
  reminderLine({ cwd = null, now = Date.now() } = {}) {
    const todayStr = today(now)
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN due IS NOT NULL AND due < ? AND status IN ('pending','doing','blocked') THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN due = ? AND status IN ('pending','doing','blocked') THEN 1 ELSE 0 END) AS dueToday,
           SUM(CASE WHEN due IS NULL AND status IN ('pending','doing','blocked') THEN 1 ELSE 0 END) AS undated
         FROM todos`,
      )
      .get(todayStr, todayStr)
    const overdue = Number(row?.overdue ?? 0)
    const dueToday = Number(row?.dueToday ?? 0)
    const undated = Number(row?.undated ?? 0)
    if (overdue + dueToday + undated === 0) return null
    const parts = []
    if (overdue > 0) parts.push(`逾期 ${overdue} 条`)
    if (dueToday > 0) parts.push(`今日到期 ${dueToday} 条`)
    if (undated > 0) parts.push(`未排期 ${undated} 条`)
    const mine = cwd ? this.list({ cwd, limit: 8 }).length : 0
    return `【待办】${parts.join(' · ')}${mine ? ` · 本项目待关注 ${mine} 条` : ''}（mem_todo list 查看）`
  }

  update(id, patch = {}) {
    const row = this.get(id)
    if (!row) return { ok: false, message: `未找到待办 ${id}` }
    const next = {
      content: patch.content ?? row.content,
      track: patch.track ?? row.track,
      status: patch.status ?? row.status,
      due: patch.due === undefined ? row.due : patch.due,
      category: patch.category === undefined ? row.category : patch.category,
      quadrant: patch.quadrant ?? (patch.important !== undefined || patch.urgent !== undefined
        ? quadrantOf({ important: patch.important ?? row.important, urgent: patch.urgent ?? row.urgent })
        : row.quadrant),
      important: patch.important === undefined ? row.important : patch.important ? 1 : 0,
      urgent: patch.urgent === undefined ? row.urgent : patch.urgent ? 1 : 0,
      day: patch.date === undefined ? row.day : patch.date,
    }
    if (!STATUSES.includes(next.status)) return { ok: false, message: `未知状态 ${next.status}` }
    const doneAt = next.status === 'done' && row.status !== 'done' ? Date.now() : row.done_at
    this.db
      .prepare(
        `UPDATE todos SET content = ?, track = ?, status = ?, due = ?, category = ?, quadrant = ?, important = ?, urgent = ?, day = ?, updated_at = ?, done_at = ?, lamport = lamport + 1
         WHERE id = ?`,
      )
      .run(next.content, next.track, next.status, next.due, next.category, next.quadrant, next.important, next.urgent, next.day, Date.now(), doneAt ?? null, id)
    this.store.logChange('todo', id, 'upsert', next)
    return { ok: true, id, status: next.status }
  }

  done(id) {
    return this.update(id, { status: 'done' })
  }

  remove(id) {
    const row = this.get(id)
    if (!row) return { ok: false, message: `未找到待办 ${id}` }
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(String(id))
    this.store.logChange('todo', String(id), 'delete', {})
    return { ok: true, id: String(id) }
  }

  stats() {
    const rows = this.db.prepare('SELECT track, status, COUNT(*) AS n FROM todos GROUP BY track, status').all()
    const byTrack = {}
    const byStatus = {}
    for (const r of rows) {
      byTrack[r.track] = (byTrack[r.track] ?? 0) + Number(r.n)
      byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.n)
    }
    return { byTrack, byStatus, total: Object.values(byTrack).reduce((a, b) => a + b, 0) }
  }

  /** 采纳待确认的待办建议。落库失败**不划勾**——建议留在待确认队列等补内容后重试。 */
  approveSuggestion({ id, overrides = {}, decidedBy = 'user' }) {
    const row = this.store.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(String(id))
    if (!row) return { ok: false, message: `未找到建议 ${id}` }
    let payload = {}
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = {}
    }
    const merged = { ...payload, ...overrides }
    const res = this.add({
      content: merged.content,
      track: merged.track ?? row.target ?? 'work',
      due: merged.due ?? null,
      scope: merged.scope ?? null,
      origin: `suggestion:${id}`,
    })
    if (!res || res.ok === false) return { ok: false, id: String(id), message: res?.message ?? '写入待办失败' }
    this.store.db.prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run('approved', Date.now(), decidedBy, String(id))
    return res
  }
}

/** 旧插件同款条目格式：`[时间] [id: xxxx] [q1] [due: …] [status: …] [cat: …]` + 内容。 */
export function stampTodoLine(todo, { time = null } = {}) {
  const d = new Date(time ?? todo.created_at ?? Date.now())
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  const parts = [`[${stamp}]`, `[id: ${todo.id}]`]
  if (todo.quadrant) parts.push(`[${todo.quadrant}]`)
  if (todo.due) parts.push(`[due: ${todo.due}]`)
  parts.push(`[status: ${todo.status ?? 'pending'}]`)
  if (todo.category) parts.push(`[cat: ${todo.category}]`)
  if (todo.done_at) parts.push(`[done: ${new Date(todo.done_at).toISOString().slice(0, 10)}]`)
  return `${parts.join(' ')}\n${String(todo.content ?? '').trim()}`
}
