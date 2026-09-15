/**
 * 健康度快照（`mem_status` 工具、`/memory-core/api/status`、面板共用）。
 * 单独成模块：避免 api.js ↔ index.js 的循环依赖。
 */
import { existsSync } from 'node:fs'
import { latestBackup, quickCheck } from './db.js'
import { backupDir, dbPath as defaultDbPath } from './paths.js'

export function health(store, host = null) {
  const db = store.db
  const check = quickCheck(db)
  return {
    schemaVersion: store.getMeta('schema_version'),
    device: store.device,
    dbPath: defaultDbPath(),
    quickCheck: check,
    latestBackup: existsSync(backupDir()) ? latestBackup(backupDir()) : null,
    counts: store.counts(),
    host: host ? { version: host.version, supported: host.supported, compatible: host.compatible, caps: host.caps } : null,
  }
}
