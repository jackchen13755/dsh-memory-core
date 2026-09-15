/**
 * Markdown 快照导出（设计 §4.4）与灾备重建。
 *
 * 快照是**只读用途**：人读 / grep / diff / 备份 / 灾备重建源；过渡期还能让旧插件
 * 的记忆 Tab 继续看到内容（布局与旧插件逐字一致）。它**不是事实源**——事实源是 SQLite。
 *
 * 导出保证：同一批数据导出的文件与旧插件原来写的文件**字节一致**
 * （条目原文逐字保留 + 同一分隔符 + 同一文件末尾换行），因此 M0 的验收可以直接用
 * "导出结果 vs 旧文件 diff" 来证明零丢失。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renderEntries } from './markdown.js'
import { stampTodoLine } from './todos.js'

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 从 `project:<slug>@<hash>` / `project:<hash>` 里取 hash。 */
function scopeHash(scope) {
  const s = String(scope ?? '')
  if (!s.startsWith('project:')) return null
  const rest = s.slice('project:'.length)
  const at = rest.lastIndexOf('@')
  return at === -1 ? rest : rest.slice(at + 1)
}

/**
 * 导出快照。
 * @param {import('./store.js').Store} store
 * @param {{ dir: string, log?: (m: string) => void }} opts
 */
export function exportSnapshot(store, opts) {
  const dir = opts.dir
  const log = opts.log ?? (() => {})
  const db = store.db
  const buckets = new Map() // relPath → entries[]
  const push = (rel, content) => {
    if (!buckets.has(rel)) buckets.set(rel, [])
    buckets.get(rel).push(content)
  }

  // 排序 = 源文件内原始顺序（ord）优先，其次按时间；新写入的条目（ord 为空）追加在后。
  const units = db
    .prepare('SELECT * FROM units WHERE status != \'superseded\' ORDER BY (ord IS NULL), ord, created_at, rowid')
    .all()
  for (const u of units) {
    const archived = u.status === 'archived'
    if (u.track === 'memory') push(archived ? 'MEMORY-archive.md' : 'MEMORY.md', u.content)
    else if (u.track === 'user') push(archived ? 'USER-archive.md' : 'USER.md', u.content)
    else if (u.track === 'daily') push(`daily/${u.day ?? 'undated'}.md`, u.content)
    else if (u.track === 'project') push(`projects/${scopeHash(u.scope)}/MEMORY.md`, u.content)
    else if (u.track === 'key') push(`projects/${scopeHash(u.scope)}/${archived ? 'KEY-archive.md' : 'KEY.md'}`, u.content)
  }

  const todos = db.prepare('SELECT * FROM todos ORDER BY created_at ASC, rowid ASC').all()
  for (const t of todos) {
    const line = stampTodoLine(t)
    if (t.track === 'life') push('TODOS-life.md', line)
    else if (t.track === 'work') push('TODOS-work.md', line)
    else if (t.track === 'project') push(`projects/${scopeHash(t.scope)}/TODOS.md`, line)
    else if (t.track === 'daily') push(`daily/${t.day ?? 'undated'}.todo.md`, line)
  }

  const files = []
  for (const [rel, entries] of buckets) {
    const abs = join(dir, rel)
    const text = renderEntries(entries)
    writeAtomic(abs, text)
    files.push({ path: rel, entries: entries.length, bytes: Buffer.byteLength(text) })
    log(`导出 ${rel}：${entries.length} 条`)
  }
  return { dir, files, units: units.length, todos: todos.length }
}

/** 本插件负责的文件（用于对账时区分"未托管文件"，避免把 scratch.md 之类算成失败）。 */
export function isManaged(rel) {
  return (
    /^(MEMORY|USER)(-archive)?\.md$/.test(rel) ||
    /^TODOS-(life|work)\.md$/.test(rel) ||
    /^daily\/[^/]+\.md$/.test(rel) ||
    /^projects\/[^/]+\/(MEMORY|KEY|KEY-archive|TODOS)\.md$/.test(rel)
  )
}

/** 递归列出目录下的 .md 文件（相对路径，排序）。 */
export function listMarkdown(dir) {
  const out = []
  if (!existsSync(dir)) return out
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel || '.'), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(r)
      else if (entry.name.endsWith('.md')) out.push(r)
    }
  }
  walk('')
  return out.sort()
}

/**
 * 快照 ↔ 旧文件对账（M0 验收）：逐文件比较字节内容与条目集合。
 * 未托管的文件标记 `not-managed`，不计入失败。
 * @returns {{ ok: boolean, files: Array<{path: string, status: string, detail?: string}> }}
 */
export function diffSnapshot(dirA, dirB, { files = null } = {}) {
  const list = files ?? [...new Set([...listMarkdown(dirA), ...listMarkdown(dirB)])].sort()
  const out = []
  let ok = true
  for (const rel of list) {
    const aPath = join(dirA, rel)
    const bPath = join(dirB, rel)
    const a = existsSync(aPath) ? readFileSync(aPath, 'utf8') : null
    const b = existsSync(bPath) ? readFileSync(bPath, 'utf8') : null
    if (a === null && b === null) continue
    if (a === b) {
      out.push({ path: rel, status: 'same' })
      continue
    }
    const aEntries = a === null ? [] : a.split('\n§\n').map((s) => s.trim()).filter(Boolean)
    const bEntries = b === null ? [] : b.split('\n§\n').map((s) => s.trim()).filter(Boolean)
    const setB = new Set(bEntries)
    const onlyA = aEntries.filter((e) => !setB.has(e))
    const onlyB = bEntries.filter((e) => !new Set(aEntries).has(e))
    const detail = `导出 ${aEntries.length} 条 / 旧库 ${bEntries.length} 条；仅导出有 ${onlyA.length}、仅旧库有 ${onlyB.length}`
    if (!isManaged(rel)) {
      out.push({ path: rel, status: 'not-managed', detail })
      continue
    }
    ok = false
    out.push({ path: rel, status: a === null ? 'missing-in-export' : b === null ? 'missing-in-legacy' : 'differs', detail })
  }
  return { ok, files: out }
}
