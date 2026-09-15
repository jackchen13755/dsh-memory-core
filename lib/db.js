/**
 * DB 打开 / 迁移 / 自检 / 备份（设计 §4.3）。
 *
 * 三条纪律：
 *   1. 打开即跑 PRAGMA（WAL + busy_timeout），多进程读写不互斥；
 *   2. schema 变更只走 `MIGRATIONS`，事务内执行；
 *   3. 备份用 `VACUUM INTO`（在线、一致、不需要停写），每日一份、轮转保留。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureDir } from './paths.js'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

/** 打开数据库并应用 PRAGMA（不建表；建表见 `migrate`）。 */
export function openDb(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `)
  return db
}

export function closeDb(db) {
  try {
    db.close()
  } catch {
    /* 已关闭 */
  }
}

/** 当前 schema 版本（meta 表还不存在时返回 0）。 */
export function currentVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    return row ? Number(row.value) : 0
  } catch {
    return 0
  }
}

/** 顺序执行未应用的迁移；每个迁移在一个事务里，失败回滚且不留半成品。 */
export function migrate(db, { log = () => {} } = {}) {
  const from = currentVersion(db)
  let applied = 0
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(m.version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 v${m.version} 失败：${error.message}`)
    }
    applied += 1
    log(`schema 迁移：v${m.version} 已应用`)
  }
  return { from, to: currentVersion(db), applied, target: SCHEMA_VERSION }
}

/** `PRAGMA quick_check`：返回 `{ ok, messages }`。 */
export function quickCheck(db) {
  try {
    const rows = db.prepare('PRAGMA quick_check').all()
    const messages = rows.map((r) => Object.values(r)[0]).filter(Boolean)
    return { ok: messages.length === 1 && messages[0] === 'ok', messages }
  } catch (error) {
    return { ok: false, messages: [error.message] }
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : fallback
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value))
}

/** 设备身份（同步用）：首次生成后固定写入 meta。 */
export function deviceId(db) {
  let id = getMeta(db, 'device_id')
  if (!id) {
    id = `dev-${Math.random().toString(16).slice(2, 10)}`
    setMeta(db, 'device_id', id)
  }
  return id
}

/** 单写者串行队列：所有写事务排队执行（读不排队）。 */
export class WriteQueue {
  constructor() {
    this.tail = Promise.resolve()
  }

  run(fn) {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  idle() {
    return this.tail
  }
}

/**
 * 每日备份：`VACUUM INTO <dir>/mem-YYYYMMDD.db`，并按 `keep` 轮转。
 * @returns {{ file: string, bytes: number, kept: number, removed: string[] }}
 */
export function backupDaily(db, dir, { keep = 7, now = new Date() } = {}) {
  ensureDir(dir)
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const file = join(dir, `mem-${stamp}.db`)
  if (existsSync(file)) rmSync(file)
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)

  const all = readdirSync(dir)
    .filter((n) => /^mem-\d{8}\.db$/.test(n))
    .sort()
    .reverse()
  const removed = []
  for (const stale of all.slice(keep)) {
    rmSync(join(dir, stale))
    removed.push(stale)
  }
  return { file, bytes: statSync(file).size, kept: Math.min(all.length, keep), removed }
}

/** 最近一次备份信息（用于健康度：备份必须新鲜）。 */
export function latestBackup(dir) {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((n) => /^mem-\d{8}\.db$/.test(n))
    .sort()
  if (files.length === 0) return null
  const name = files[files.length - 1]
  const st = statSync(join(dir, name))
  return { name, bytes: st.size, mtime: st.mtimeMs, count: files.length }
}
