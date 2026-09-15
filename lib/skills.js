/**
 * 技能模块（设计 §10）：**技能文件是真相，SQLite 只做索引与状态**。
 *
 * DSH 从文件系统加载技能（`~/.agents/skills/<name>/SKILL.md`），所以这里只做三件事：
 *   ① 索引：扫描技能目录，把 name/description/hash/bytes/启用状态写进 `skills` 表；
 *   ② 管理：`list / read / create / update / enable / disable`；
 *   ③ 启用状态落地为**官方 frontmatter 字段** `disable-model-invocation`（scope 层与
 *      global 层都生效）——不改文件以外的任何"私有开关"，DSH 自己就认。
 *
 * 一致性：文件的 hash 与库内索引不一致时**以文件为准**并重建索引（手改文件是合法操作）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { skillsDir } from './paths.js'
import { sha1 } from './paths.js'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseSkill(text) {
  const m = FRONTMATTER.exec(String(text ?? ''))
  const raw = m ? m[1] : ''
  const pick = (key) => {
    const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(raw)
    return hit ? hit[1].trim().replace(/^["']|["']$/g, '') : null
  }
  return {
    hasFrontmatter: Boolean(m),
    name: pick('name'),
    description: pick('description'),
    disabled: /^disable-model-invocation:\s*true\s*$/m.test(raw),
    body: m ? String(text).slice(m[0].length) : String(text ?? ''),
    frontmatter: raw,
  }
}

/** 在 frontmatter 里增删一个布尔标记（没有 frontmatter 时补一个）。 */
export function setFrontmatterFlag(text, key, value) {
  const source = String(text ?? '')
  const m = FRONTMATTER.exec(source)
  if (!m) {
    if (value === false) return source
    return `---\n${key}: true\n---\n\n${source.replace(/^\s*\n/, '')}`
  }
  const body = m[1]
  const rest = source.slice(m[0].length)
  const lines = body.split(/\r?\n/).filter((line) => !new RegExp(`^\\s*${key}\\s*:`).test(line))
  if (value === true) lines.push(`${key}: true`)
  const next = lines.filter((l) => l.trim() !== '')
  return `---\n${next.join('\n')}\n---\n${rest}`
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export class SkillManager {
  constructor(store, { dir = null } = {}) {
    this.store = store
    this.dir = dir ?? skillsDir()
  }

  skillFile(name) {
    return join(this.dir, String(name), 'SKILL.md')
  }

  /** 扫描并同步索引（文件为准；索引不一致就重建）。 */
  scan() {
    if (!existsSync(this.dir)) return { ok: true, scanned: 0, indexed: 0 }
    const names = readdirSync(this.dir).filter((n) => {
      try {
        return statSync(join(this.dir, n)).isDirectory()
      } catch {
        return false
      }
    })
    let indexed = 0
    for (const dirName of names) {
      const file = join(this.dir, dirName, 'SKILL.md')
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      const parsed = parseSkill(text)
      const stat = statSync(file)
      const hash = sha1(text).slice(0, 16)
      const source = dirName.startsWith('project-') ? 'project' : dirName.startsWith('user-') ? 'user' : 'custom'
      this.store.upsertSkill({
        name: parsed.name ?? dirName,
        path: relative(this.dir, file),
        source,
        description: parsed.description,
        enabled: parsed.disabled ? 0 : 1,
        hash,
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
      })
      indexed += 1
    }
    return { ok: true, scanned: names.length, indexed }
  }

  list({ q = null, enabledOnly = false, source = null, limit = 200 } = {}) {
    const rows = this.store.listSkills({})
    return rows
      .filter((r) => (enabledOnly ? r.enabled === 1 : true))
      .filter((r) => (source ? r.source === source : true))
      .filter((r) => (q ? `${r.name} ${r.description ?? ''}`.includes(q) : true))
      .slice(0, limit)
  }

  /** 读取技能全文（顺带校正索引）。 */
  read(name) {
    const file = this.skillFile(name)
    if (!existsSync(file)) return { ok: false, message: `未找到技能 ${name}` }
    const text = readFileSync(file, 'utf8')
    const parsed = parseSkill(text)
    this.store.upsertSkill({
      name: parsed.name ?? name,
      path: relative(this.dir, file),
      source: 'custom',
      description: parsed.description,
      enabled: parsed.disabled ? 0 : 1,
      hash: sha1(text).slice(0, 16),
      bytes: statSync(file).size,
      updatedAt: Date.now(),
    })
    return { ok: true, name: parsed.name ?? name, description: parsed.description, body: parsed.body, disabled: parsed.disabled, content: text }
  }

  /** 新建技能（写入 `~/.agents/skills/<name>/SKILL.md`，并同步索引）。 */
  create({ name, description, body }) {
    const clean = String(name ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(clean)) return { ok: false, message: '技能名必须是 kebab-case（小写字母/数字/连字符）' }
    const text = String(body ?? '').trim()
    if (text.length < 20) return { ok: false, message: '技能正文太短（至少 20 字）' }
    const file = this.skillFile(clean)
    if (existsSync(file)) return { ok: false, message: `技能 ${clean} 已存在` }
    const head = `---\nname: ${clean}\ndescription: ${String(description ?? clean).replace(/\n/g, ' ')}\n---\n\n`
    writeAtomic(file, head + text + '\n')
    this.scan()
    return { ok: true, name: clean, path: relative(this.dir, file) }
  }

  /** 更新技能正文（read-before-write：先读原文件，保留 frontmatter 的其它字段）。 */
  update(name, { body = null, description = null }) {
    const file = this.skillFile(name)
    if (!existsSync(file)) return { ok: false, message: `未找到技能 ${name}` }
    const original = readFileSync(file, 'utf8')
    const parsed = parseSkill(original)
    let nextBody = body === null ? parsed.body : String(body)
    let nextFm = parsed.frontmatter
    if (description !== null) {
      nextFm = /^description:/m.test(nextFm)
        ? nextFm.replace(/^description:.*$/m, `description: ${String(description).replace(/\n/g, ' ')}`)
        : `${nextFm}\ndescription: ${String(description).replace(/\n/g, ' ')}`
    }
    writeAtomic(file, `---\n${nextFm.trim()}\n---\n\n${nextBody.trim()}\n`)
    this.scan()
    return { ok: true, name }
  }

  /** 启用/禁用：落地为官方 frontmatter `disable-model-invocation`。 */
  setEnabled(name, enabled) {
    const file = this.skillFile(name)
    if (!existsSync(file)) return { ok: false, message: `未找到技能 ${name}` }
    const text = readFileSync(file, 'utf8')
    const parsed = parseSkill(text)
    const next = setFrontmatterFlag(text, 'disable-model-invocation', enabled === false)
    if (next !== text) writeAtomic(file, next)
    this.scan()
    return { ok: true, name, enabled: enabled !== false, wasDisabled: parsed.disabled }
  }

  /** 待确认的新技能建议（自进化审查产出）。 */
  pendingSuggestions() {
    return this.store.listSuggestions({ status: 'pending', kind: 'skill' })
  }

  suggest({ name, description, body, sessionId = null, reason = '自进化审查建议' }) {
    const { id, inserted } = this.store.insertSuggestion({
      kind: 'skill',
      target: name ?? null,
      payload: { name, description, body, reason },
      sessionId,
    })
    return { ok: true, id, inserted, status: inserted ? 'queued' : 'queued-duplicate' }
  }

  /** 采纳技能建议：写入技能库。 */
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
    const res = this.create({ name: merged.name, description: merged.description, body: merged.body })
    this.store.db.prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run('approved', Date.now(), decidedBy, String(id))
    return res
  }
}
