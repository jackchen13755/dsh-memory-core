/**
 * 路径与身份解析（设计 §4.2）。
 *
 * 事实源是 SQLite（`$DSH_HOME/memory-core/mem.db`）；旧插件（dsh-memory-evolve）
 * 的 Markdown 目录 `$DSH_HOME/memories/` 在本插件里是**导入源**与**快照导出目标**
 * （不是事实源）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** `$DSH_HOME`（缺省 `~/.dsh`）。 */
export function dshHome(env = process.env) {
  return env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh')
}

/** 旧插件的 Markdown 记忆目录（导入源 / 快照导出目标）。 */
export function legacyMemoryDir(env = process.env) {
  return join(dshHome(env), 'memories')
}

/** 本插件的数据目录（DB、备份、变更日志）。 */
export function dataDir(env = process.env) {
  return join(dshHome(env), 'memory-core')
}

export function dbPath(env = process.env) {
  return join(dataDir(env), 'mem.db')
}

export function backupDir(env = process.env) {
  return join(dataDir(env), 'backups')
}

export function changesDir(env = process.env) {
  return join(dataDir(env), 'changes')
}

/** 技能库目录（技能文件是真相，DB 只做索引）。 */
export function skillsDir(env = process.env) {
  return env.DSH_SKILLS_DIR ? resolve(env.DSH_SKILLS_DIR) : join(homedir(), '.agents', 'skills')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 旧插件与新版共用的项目标识：`sha1(cwd).slice(0, 12)`。
 * 保持完全一致，旧数据才能零迁移对齐（设计 §4.2）。
 */
export function projectHash(cwd) {
  return createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12)
}

export function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex')
}

/** 条目身份证（8 hex）：沿用旧格式 `[id:xxxxxxxx]`，并作为同步合并锚点。 */
export function deriveEntryId(...parts) {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 8)
}

/**
 * 项目作用域标识：有 git remote 时用 `<slug>@<hash>`，否则退化为 `<hash>`。
 * legacy 导入没有 remote 信息，先按 hash 建，等会话提供 remote 后再补写。
 */
export function scopeForProject({ cwd, remote }) {
  const hash = projectHash(cwd)
  if (!remote) return `project:${hash}`
  const slug = String(remote)
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .toLowerCase()
  return `project:${slug}@${hash}`
}

export const GLOBAL_SCOPE = 'global'
