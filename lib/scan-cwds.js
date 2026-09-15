/**
 * 旧记忆库反查：把 `projects/<sha1(cwd).slice(0,12)>` 目录还原成真实 cwd（设计 §11）。
 *
 * 为什么需要：旧插件按 cwd 的 sha1 前 12 位分目录，**不落 cwd 明文**；而新库要按
 * cwd / git remote 解析作用域。做法是对已知的项目根目录做一次有界扫描，逐个算
 * sha1 前 12 位去匹配（本机 6 个历史项目全部一次性对上）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const hashOf = (p) => createHash('sha1').update(p).digest('hex').slice(0, 12)

/** 默认扫描根：用户放代码的几个常见位置（有界，深度 2）。 */
export function defaultRoots(env = process.env) {
  if (env.DSH_PROJECT_DIRS) return env.DSH_PROJECT_DIRS.split(':').filter(Boolean).map((p) => resolve(p))
  const home = homedir()
  return ['Desktop', 'Desktop/work', 'Desktop/dsh', 'Desktop/dsh/github', 'Documents', 'projects', 'code', 'src', 'work']
    .map((p) => join(home, p))
    .filter((p) => existsSync(p))
}

/**
 * 反查项目 hash → cwd。
 * @param {Iterable<string>} hashes 需要的 hash 列表
 * @param {{ roots?: string[], maxDepth?: number }} [opts]
 * @returns {Map<string, string>}
 */
export function mapProjectHashes(hashes, opts = {}) {
  const want = new Set(hashes)
  const roots = opts.roots ?? defaultRoots()
  const maxDepth = opts.maxDepth ?? 2
  const found = new Map()

  const walk = (dir, depth) => {
    if (depth > maxDepth || found.size === want.size) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const h = hashOf(full)
      if (want.has(h) && !found.has(h)) found.set(h, full)
      walk(full, depth + 1)
    }
  }
  for (const root of roots) walk(root, 0)
  return found
}
