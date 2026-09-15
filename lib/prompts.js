/**
 * 提示词管理器（设计新增模块；语义参考 dsh-memory-evolve 的 Prompt Manager）。
 *
 * 三块：
 *   ① 库：提示词 CRUD + 分类 + 标签 + 启用开关 + 使用统计（存 SQLite，事实源统一）；
 *   ② 注入轨：把某条提示词注入到会话——一次性 / 持续 / 次数×间隔；
 *      `countdown===0` 表示"本轮该出现"，每回合结束由 `agent/turn-stopping` 推进；
 *   ③ 段渲染：只在"该出现"的回合渲染，文案是给模型的指令（不暴露机制）。
 *
 * ⚠️ 一个必须防的坑（沿用旧插件的结论）：宿主 `dsh-system-prompt` 的段渲染器会把
 * 文本里的 `{{...}}` 当模板变量解析，**未注册变量直接 throw**，整轮上下文注入会失败。
 * 所以进入段之前必须 `sanitizeSnapshotBody()`：先展开 {{date}}/{{time}}，再把残留的
 * `{{x}}` 降级为 `{x}`、`{{` 降级为 `{`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveEntryId } from './paths.js'

const here = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_CATEGORIES = ['需求', '设计', '开发', '测试', '评审', '调试', '运维', '写作', '临时']

export function expandVars(text, vars = {}) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const builtin = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
  const all = { ...builtin, ...vars }
  return String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (raw, key) => (Object.hasOwn(all, key) ? all[key] : raw))
}

/** 展开变量并把宿主能解析的 `{{...}}` 全部拆掉（否则整轮注入失败）。 */
export function sanitizeSnapshotBody(content) {
  return expandVars(content)
    .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '{$1}')
    .replace(/\{\{/g, '{')
}

function safeJson(text, fallback = []) {
  try {
    const v = text ? JSON.parse(text) : fallback
    return v ?? fallback
  } catch {
    return fallback
  }
}

export class PromptManager {
  constructor(store, { seedFile = join(here, 'prompts-seed.json') } = {}) {
    this.store = store
    this.db = store.db
    this.seedFile = seedFile
    this.ensureCategories()
  }

  // ── 分类 ──────────────────────────────────────────────────────────────
  ensureCategories() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM prompt_categories').get()
    if (Number(row?.n ?? 0) === 0) {
      const stmt = this.db.prepare('INSERT OR IGNORE INTO prompt_categories (name, builtin, created_at) VALUES (?, 1, ?)')
      for (const name of DEFAULT_CATEGORIES) stmt.run(name, Date.now())
    }
  }

  listCategories() {
    return this.db.prepare('SELECT name, builtin FROM prompt_categories ORDER BY builtin DESC, name').all()
  }

  addCategory(name) {
    const clean = String(name ?? '').trim()
    if (!clean) return { ok: false, message: '分类名不能为空' }
    this.db.prepare('INSERT OR IGNORE INTO prompt_categories (name, builtin, created_at) VALUES (?, 0, ?)').run(clean, Date.now())
    return { ok: true, name: clean }
  }

  removeCategory(name, { moveTo = '临时' } = {}) {
    const clean = String(name ?? '').trim()
    if (!clean) return { ok: false, message: '分类名不能为空' }
    const tx = this.db
    tx.exec('BEGIN')
    try {
      this.db.prepare('UPDATE prompts SET category = ?, updated_at = ? WHERE category = ?').run(moveTo, Date.now(), clean)
      this.db.prepare('DELETE FROM prompt_categories WHERE name = ?').run(clean)
      tx.exec('COMMIT')
    } catch (error) {
      tx.exec('ROLLBACK')
      return { ok: false, message: error.message }
    }
    return { ok: true, moved: moveTo }
  }

  // ── 库 ────────────────────────────────────────────────────────────────
  listPrompts({ category = null, tag = null, q = null, enabledOnly = false, limit = 200 } = {}) {
    const where = []
    const args = []
    if (category) (where.push('category = ?'), args.push(category))
    if (enabledOnly) where.push('enabled = 1')
    if (q) (where.push('(name LIKE ? OR summary LIKE ? OR body LIKE ?)'), args.push(`%${q}%`, `%${q}%`, `%${q}%`))
    const rows = this.db
      .prepare(`SELECT * FROM prompts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, uses DESC LIMIT ?`)
      .all(...args, limit)
    return rows
      .map((r) => ({ ...r, tags: safeJson(r.tags), enabled: r.enabled === 1 }))
      .filter((r) => (tag ? r.tags.includes(tag) : true))
  }

  getPrompt(idOrName) {
    const row =
      this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(String(idOrName)) ??
      this.db.prepare('SELECT * FROM prompts WHERE name = ? ORDER BY updated_at DESC LIMIT 1').get(String(idOrName))
    if (!row) return null
    return { ...row, tags: safeJson(row.tags), enabled: row.enabled === 1 }
  }

  createPrompt({ name, summary = '', category = '临时', tags = [], body, source = 'user', id = null }) {
    const cleanName = String(name ?? '').trim()
    const cleanBody = String(body ?? '').trim()
    if (!cleanName) return { ok: false, message: '名称不能为空' }
    if (!cleanBody) return { ok: false, message: '正文不能为空' }
    const cat = String(category ?? '临时').trim() || '临时'
    this.addCategory(cat)
    const pid = id ?? deriveEntryId('prompt', cleanName, cleanBody.slice(0, 64))
    const now = Date.now()
    const existing = this.db.prepare('SELECT id FROM prompts WHERE id = ?').get(pid)
    if (existing) return { ok: false, message: `提示词已存在：${pid}` }
    this.db
      .prepare(
        `INSERT INTO prompts (id, name, summary, category, tags, body, enabled, uses, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      )
      .run(pid, cleanName, String(summary ?? ''), cat, JSON.stringify(tags ?? []), cleanBody, source, now, now)
    return { ok: true, id: pid }
  }

  updatePrompt(id, patch = {}) {
    const row = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(String(id))
    if (!row) return { ok: false, message: `未找到提示词 ${id}` }
    const next = {
      name: patch.name ?? row.name,
      summary: patch.summary ?? row.summary,
      category: patch.category ?? row.category,
      tags: patch.tags ? JSON.stringify(patch.tags) : row.tags,
      body: patch.body ?? row.body,
      enabled: patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
    }
    if (patch.category) this.addCategory(patch.category)
    this.db
      .prepare('UPDATE prompts SET name = ?, summary = ?, category = ?, tags = ?, body = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.summary, next.category, next.tags, next.body, next.enabled, Date.now(), String(id))
    return { ok: true, id: String(id) }
  }

  setEnabled(id, enabled) {
    return this.updatePrompt(id, { enabled })
  }

  deletePrompt(id) {
    const row = this.db.prepare('SELECT id FROM prompts WHERE id = ?').get(String(id))
    if (!row) return { ok: false, message: `未找到提示词 ${id}` }
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM prompt_injections WHERE prompt_id = ?').run(String(id))
      this.db.prepare('DELETE FROM prompts WHERE id = ?').run(String(id))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      return { ok: false, message: error.message }
    }
    return { ok: true, id: String(id) }
  }

  /** 首次装配写入种子库（已存在同名条目不覆盖）。 */
  importSeed({ file = this.seedFile } = {}) {
    let data
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      return { ok: false, message: `读取种子库失败：${error.message}`, imported: 0 }
    }
    let imported = 0
    for (const p of data.prompts ?? []) {
      const exists = this.db.prepare('SELECT id FROM prompts WHERE name = ?').get(p.name)
      if (exists) continue
      const res = this.createPrompt({ ...p, source: 'seed' })
      if (res.ok) imported += 1
    }
    if (data.categories) for (const c of data.categories) this.addCategory(c)
    return { ok: true, imported }
  }

  /** 从旧插件的 prompts.json 导入（兼容 Prompts 存储形状）。 */
  importLegacy(file) {
    let data
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      return { ok: false, message: `读取失败：${error.message}`, imported: 0 }
    }
    const list = data.prompts ?? data.items ?? []
    let imported = 0
    for (const c of data.categories ?? []) this.addCategory(c)
    for (const p of list) {
      const exists = this.db.prepare('SELECT id FROM prompts WHERE name = ?').get(p.name)
      if (exists) continue
      const res = this.createPrompt({
        name: p.name,
        summary: p.description ?? p.summary ?? '',
        category: p.category ?? '临时',
        tags: p.tags ?? [],
        body: p.content ?? p.body ?? '',
        source: 'import',
      })
      if (res.ok) imported += 1
    }
    return { ok: true, imported, total: list.length }
  }

  // ── 注入轨 ────────────────────────────────────────────────────────────
  /**
   * 建一条注入。
   * @param {{ promptId?: string|null, title: string, content: string, rounds?: number|null, every?: number, sessionId?: string|null }} input
   *   rounds：出现次数（默认 1；**null/0 = 无限**，持续到手动停止）；every：间隔回合（默认 1；**0 = 只出现一次**）
   */
  createInjection({ promptId = null, title, content, rounds = 1, every = 1, sessionId = null }) {
    const text = String(content ?? '').trim()
    if (!text) return { ok: false, message: '注入内容为空' }
    let roundsLeft = rounds === null || rounds === undefined || rounds === 0 ? null : Math.max(1, Number(rounds))
    let interval = Number.isFinite(Number(every)) ? Number(every) : 1
    if (interval <= 0) {
      // 间隔 0 = 只出现一次（用户直觉语义）
      interval = 1
      roundsLeft = 1
    }
    const id = deriveEntryId('inject', title, text.slice(0, 32), String(Date.now()))
    this.db
      .prepare(
        `INSERT INTO prompt_injections (id, prompt_id, session_id, title, content, rounds_left, every, countdown, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      )
      .run(id, promptId, sessionId, String(title ?? '规则'), text, roundsLeft, interval, Date.now())
    if (promptId) this.db.prepare('UPDATE prompts SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(Date.now(), promptId)
    return { ok: true, id, roundsLeft, every: interval }
  }

  listInjections({ sessionId = undefined, activeOnly = true } = {}) {
    const where = []
    const args = []
    if (activeOnly) where.push('active = 1')
    if (sessionId !== undefined) (where.push('(session_id IS NULL OR session_id = ?)'), args.push(sessionId))
    return this.db
      .prepare(`SELECT * FROM prompt_injections ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`)
      .all(...args)
  }

  activeFor(promptId) {
    return this.db.prepare('SELECT * FROM prompt_injections WHERE prompt_id = ? AND active = 1').all(String(promptId))
  }

  stopInjection(id) {
    const res = this.db.prepare('UPDATE prompt_injections SET active = 0 WHERE id = ?').run(String(id))
    return { ok: Number(res.changes ?? 0) > 0, id: String(id) }
  }

  stopAll({ sessionId = undefined } = {}) {
    if (sessionId === undefined) {
      const res = this.db.prepare('UPDATE prompt_injections SET active = 0 WHERE active = 1').run()
      return { stopped: Number(res.changes ?? 0) }
    }
    const res = this.db.prepare('UPDATE prompt_injections SET active = 0 WHERE active = 1 AND session_id = ?').run(sessionId)
    return { stopped: Number(res.changes ?? 0) }
  }

  /**
   * 回合推进（`agent/turn-stopping`，仅主会话调用）。
   * 本轮出现过的（countdown===0）消耗一次；有限次数归零则移除；否则重置 countdown = every - 1；
   * 未出现的 countdown 递减。无限注入（rounds_left IS NULL）永不自动过期。
   */
  tickTurn(sessionId) {
    const rows = this.listInjections({ sessionId, activeOnly: true })
    let shown = 0
    let removed = 0
    const tx = this.db
    tx.exec('BEGIN')
    try {
      for (const row of rows) {
        const countdown = Number(row.countdown ?? 0)
        if (countdown <= 0) {
          shown += 1
          this.db.prepare('UPDATE prompt_injections SET last_shown_at = ? WHERE id = ?').run(Date.now(), row.id)
          if (row.rounds_left === null || row.rounds_left === undefined) {
            this.db.prepare('UPDATE prompt_injections SET countdown = ? WHERE id = ?').run(Math.max(0, Number(row.every) - 1), row.id)
            continue
          }
          const left = Number(row.rounds_left) - 1
          if (left <= 0) {
            this.db.prepare('DELETE FROM prompt_injections WHERE id = ?').run(row.id)
            removed += 1
          } else {
            this.db
              .prepare('UPDATE prompt_injections SET rounds_left = ?, countdown = ? WHERE id = ?')
              .run(left, Math.max(0, Number(row.every) - 1), row.id)
          }
        } else {
          this.db.prepare('UPDATE prompt_injections SET countdown = ? WHERE id = ?').run(countdown - 1, row.id)
        }
      }
      tx.exec('COMMIT')
    } catch (error) {
      tx.exec('ROLLBACK')
      return { ok: false, message: error.message }
    }
    return { ok: true, shown, removed, active: rows.length - removed }
  }

  /** 段渲染：只渲染"本轮该出现"的注入（countdown===0）。 */
  renderSection(sessionId) {
    const due = this.listInjections({ sessionId, activeOnly: true }).filter((i) => Number(i.countdown ?? 0) <= 0)
    if (due.length === 0) return ''
    const lines = ['【用户规则（必须遵循）】']
    for (const injection of due) {
      lines.push(`- 「${injection.title}」：`)
      const body = sanitizeSnapshotBody(injection.content)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
      lines.push(body)
    }
    return lines.join('\n')
  }
}
