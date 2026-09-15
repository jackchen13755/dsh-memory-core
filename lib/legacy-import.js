/**
 * 迁移导入器（设计 §11，M0 交付物）。
 *
 * 从旧插件（dsh-memory-evolve）的 Markdown 记忆库一次性导入：
 *   五轨记忆（memory / user / key / project / daily）+ 归档 + 待办 + 建议队列 + 技能索引。
 *
 * 三条纪律：
 *   1. **只读源目录**（绝不改旧文件，旧库保留作为回滚点）；
 *   2. **逐字保留条目原文**（content = 原文，导出可字节级回放）；
 *   3. **幂等**：靠 (content_hash, track, scope) 唯一索引去重，重复导入只统计不落库。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { extractEntities } from './entities.js'
import { entryTimestamp, parseFile, parseTodoEntry, splitEntries } from './markdown.js'
import { legacyMemoryDir, sha1, skillsDir } from './paths.js'
import { mapProjectHashes } from './scan-cwds.js'

export { extractEntities }

/** 启发式 kind 推断（设计 R9：无 LLM 时的兜底；可在待确认面板里改）。 */
export function inferKind(text, track) {
  const t = String(text ?? '')
  if (track === 'daily') return 'progress'
  if (/(必须|不要|禁止|一律|统一用|优先用|务必|应当|禁止裸用)/.test(t)) return 'rule'
  if (/(根因|踩坑|坑：|教训|会导致|易踩|注意：)/.test(t)) return 'pitfall'
  if (/(拍板|决定|约定|定下|结论|方案)/.test(t)) return 'decision'
  if (/(偏好|习惯|风格|喜欢)/.test(t)) return 'preference'
  if (track === 'project') return 'progress'
  if (/(环境|安装|版本|路径|命令|脚本|配置)/.test(t)) return 'env'
  return 'fact'
}

function parseSkillFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fm = m ? m[1] : ''
  const pick = (key) => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'm')
    const hit = re.exec(fm)
    if (!hit) return null
    return hit[1].trim().replace(/^["']|["']$/g, '')
  }
  const disabled = /^disable-model-invocation:\s*true\s*$/m.test(fm)
  return { name: pick('name'), description: pick('description'), enabled: disabled ? 0 : 1 }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 执行导入。
 * @param {import('./store.js').Store} store
 * @param {{ dir?: string, skillsRoot?: string|null, roots?: string[], log?: (m: string) => void }} [opts]
 */
export function importLegacy(store, opts = {}) {
  const dir = opts.dir ?? legacyMemoryDir()
  const log = opts.log ?? (() => {})
  const report = {
    dir,
    projects: [],
    files: [],
    units: { total: 0, inserted: 0, skipped: 0, byTrack: {} },
    todos: { total: 0, inserted: 0, skipped: 0 },
    suggestions: { total: 0, inserted: 0, skipped: 0 },
    skills: { total: 0, inserted: 0 },
    errors: [],
  }

  if (!existsSync(dir)) {
    report.errors.push(`记忆目录不存在：${dir}`)
    return report
  }

  // --- 项目目录反查（hash → cwd）------------------------------------------
  const projectsDir = join(dir, 'projects')
  const hashes = existsSync(projectsDir)
    ? readdirSync(projectsDir).filter((n) => statSync(join(projectsDir, n)).isDirectory())
    : []
  const hashToCwd = mapProjectHashes(hashes, { roots: opts.roots })
  for (const hash of hashes) {
    const cwd = hashToCwd.get(hash) ?? null
    const label = cwd ? basename(cwd) : null
    store.putProject({ hash, cwd, label })
    report.projects.push({ hash, cwd, label })
  }

  // --- 记忆文件 ------------------------------------------------------------
  const plan = [
    { file: 'MEMORY.md', track: 'memory', scope: 'global', status: 'active' },
    { file: 'USER.md', track: 'user', scope: 'global', status: 'active' },
    { file: 'MEMORY-archive.md', track: 'memory', scope: 'global', status: 'archived' },
    { file: 'USER-archive.md', track: 'user', scope: 'global', status: 'archived' },
  ]
  for (const hash of hashes) {
    plan.push({ file: `projects/${hash}/MEMORY.md`, track: 'project', scope: `project:${hash}`, status: 'active', hash })
    plan.push({ file: `projects/${hash}/KEY.md`, track: 'key', scope: `project:${hash}`, status: 'active', hash })
    plan.push({ file: `projects/${hash}/KEY-archive.md`, track: 'key', scope: `project:${hash}`, status: 'archived', hash })
  }
  const dailyDir = join(dir, 'daily')
  if (existsSync(dailyDir)) {
    for (const name of readdirSync(dailyDir).filter((n) => n.endsWith('.md') && !n.endsWith('.todo.md')).sort()) {
      plan.push({ file: `daily/${name}`, track: 'daily', scope: 'global', status: 'active', day: name.replace(/\.md$/, '') })
    }
  }

  for (const item of plan) {
    const abs = join(dir, item.file)
    if (!existsSync(abs)) continue
    const text = readText(abs)
    if (text === null) {
      report.errors.push(`读取失败：${item.file}`)
      continue
    }
    const entries = parseFile(text)
    const row = { path: item.file, track: item.track, entries: entries.length, inserted: 0, skipped: 0, hashes: [] }
    for (const [ord, meta] of entries.entries()) {
      const content = meta.content
      row.hashes.push(sha1(content))
      report.units.total += 1
      report.units.byTrack[item.track] = (report.units.byTrack[item.track] ?? 0) + 1
      const label = item.hash ? (hashToCwd.get(item.hash) ? basename(hashToCwd.get(item.hash)) : null) : meta.label
      const unitMeta = {
        label: label ?? null,
        git: meta.git ?? null,
        summary: meta.summary ?? null,
        legacyId: meta.id ?? null,
        tags: meta.label ? [meta.label] : [],
        ent: extractEntities(content),
      }
      const { inserted } = store.insertUnit(
        {
          id: meta.id ?? undefined,
          track: item.track,
          scope: item.scope,
          kind: inferKind(content, item.track),
          content,
          meta: unitMeta,
          day: item.day ?? meta.date ?? null,
          ord,
          sourceFile: item.file,
          createdAt: entryTimestamp(meta, { fileDay: item.day ?? null }),
          gitBranch: meta.git ?? meta.branch ?? null,
          status: item.status,
          importance: item.track === 'key' ? 0.8 : item.track === 'project' ? 0.4 : 0.6,
          origin: 'import',
        },
        { record: false },
      )
      if (inserted) {
        row.inserted += 1
        report.units.inserted += 1
      } else {
        row.skipped += 1
        report.units.skipped += 1
      }
    }
    report.files.push(row)
    log(`${item.file}：${entries.length} 条（新增 ${row.inserted} / 已存在 ${row.skipped}）`)
  }

  // --- 待办 ---------------------------------------------------------------
  const todoPlan = [
    { file: 'TODOS-life.md', track: 'life', scope: null, day: null },
    { file: 'TODOS-work.md', track: 'work', scope: null, day: null },
    { file: 'TODO-archive.md', track: 'work', scope: null, day: null, status: 'done' },
  ]
  for (const hash of hashes) todoPlan.push({ file: `projects/${hash}/TODOS.md`, track: 'project', scope: `project:${hash}` })
  if (existsSync(dailyDir)) {
    for (const name of readdirSync(dailyDir).filter((n) => n.endsWith('.todo.md')).sort()) {
      todoPlan.push({ file: `daily/${name}`, track: 'daily', day: name.replace(/\.todo\.md$/, '') })
    }
  }
  for (const item of todoPlan) {
    const abs = join(dir, item.file)
    if (!existsSync(abs)) continue
    const text = readText(abs) ?? ''
    for (const raw of splitEntries(text)) {
      const parsed = parseTodoEntry(raw, { track: item.track, scope: item.scope ?? null, day: item.day ?? null })
      if (!parsed.content) continue
      report.todos.total += 1
      const { inserted } = store.insertTodo({ ...parsed, status: item.status ?? parsed.status })
      if (inserted) {
        report.todos.inserted += 1
      } else {
        report.todos.skipped += 1
      }
    }
    log(`${item.file}：待办已导入`)
  }

  // --- 建议队列 -----------------------------------------------------------
  const sugFile = join(dir, 'SUGGESTIONS.jsonl')
  if (existsSync(sugFile)) {
    for (const line of (readText(sugFile) ?? '').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      report.suggestions.total += 1
      try {
        const parsed = JSON.parse(trimmed)
        const { inserted } = store.insertSuggestion({
          kind: parsed.kind ?? (String(parsed.target ?? '').startsWith('todo') ? 'todo' : 'memory'),
          target: parsed.target ?? null,
          payload: parsed.payload ?? parsed,
          sessionId: parsed.sessionId ?? null,
          createdAt: parsed.createdAt ?? null,
          status: parsed.status ?? 'pending',
        })
        if (inserted) report.suggestions.inserted += 1
        else report.suggestions.skipped += 1
      } catch (error) {
        report.errors.push(`SUGGESTIONS.jsonl 解析失败：${error.message}`)
      }
    }
  }

  // --- 技能索引（只建索引，不动文件）--------------------------------------
  const sroot = opts.skillsRoot === undefined ? skillsDir() : opts.skillsRoot
  if (sroot && existsSync(sroot)) {
    for (const name of readdirSync(sroot)) {
      const skillFile = join(sroot, name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const text = readText(skillFile) ?? ''
      const fm = parseSkillFrontmatter(text)
      store.upsertSkill({
        name: fm.name ?? name,
        path: relative(sroot, skillFile),
        source: name.startsWith('project-') ? 'project' : name.startsWith('user-') ? 'user' : 'custom',
        description: fm.description,
        enabled: fm.enabled,
        hash: sha1(text).slice(0, 16),
        bytes: Buffer.byteLength(text),
        updatedAt: statSync(skillFile).mtimeMs,
      })
      report.skills.total += 1
      report.skills.inserted += 1
    }
  }

  store.setMeta(
    'import_report',
    JSON.stringify({
      at: new Date().toISOString(),
      dir,
      units: report.units,
      todos: report.todos,
      suggestions: report.suggestions,
      skills: report.skills,
      projects: report.projects.length,
      files: report.files.length,
      errors: report.errors.length,
    }),
  )

  return report
}
