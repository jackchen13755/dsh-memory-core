import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { backupDaily, closeDb, latestBackup, migrate, openDb, quickCheck } from '../lib/db.js'
import { Store } from '../lib/store.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'memcore-db-'))

function freshStore() {
  const db = openDb(join(tmp(), 'mem.db'))
  migrate(db)
  return { db, store: new Store(db) }
}

test('迁移可重复执行且版本单调', () => {
  const db = openDb(join(tmp(), 'mem.db'))
  const first = migrate(db)
  assert.equal(first.from, 0)
  assert.equal(first.to, first.target)
  const second = migrate(db)
  assert.equal(second.applied, 0)
  assert.equal(second.from, second.to)
  assert.ok(quickCheck(db).ok)
  closeDb(db)
})

test('FTS5 可用性：写入即进索引，bigram OR 查询命中，隐式 AND 不命中', async () => {
  const { db, store } = freshStore()
  store.insertUnit({ track: 'memory', scope: 'global', content: '跨项目底部按钮直接用 @/components/FooterButton，不要手写布局。' })

  const { ftsQuery, tokensField } = await import('../lib/tokens.js')
  const orHit = db.prepare('SELECT content FROM units_fts WHERE units_fts MATCH ?').all(ftsQuery('底部按钮怎么加'))
  assert.equal(orHit.length, 1, 'OR 查询应命中')

  const andQ = tokensField('底部按钮怎么加').split(' ').join(' AND ')
  const andHit = db.prepare('SELECT content FROM units_fts WHERE units_fts MATCH ?').all(andQ)
  assert.equal(andHit.length, 0, '隐式/显式 AND 会 0 命中（这条钉住设计里那个坑）')

  const idHit = db.prepare('SELECT content FROM units_fts WHERE units_fts MATCH ?').all(ftsQuery('@/components/FooterButton'))
  assert.equal(idHit.length, 1, '标识符应可精确命中')
  closeDb(db)
})

test('单元写入幂等：同 track/scope/content 不重复', () => {
  const { db, store } = freshStore()
  const a = store.insertUnit({ track: 'key', scope: 'project:abc', content: '约定：统一用 cross_project 封装。' })
  const b = store.insertUnit({ track: 'key', scope: 'project:abc', content: '约定：统一用 cross_project 封装。' })
  assert.equal(a.inserted, true)
  assert.equal(b.inserted, false)
  assert.equal(store.counts().units, 1)
  assert.equal(store.counts().fts, 1)
  closeDb(db)
})

test('修改留版本：version++ 且旧版本进 unit_history', () => {
  const { db, store } = freshStore()
  const { id } = store.insertUnit({ track: 'memory', scope: 'global', content: '旧文案' }, { record: true })
  const res = store.updateUnit(id, { content: '新文案', reason: '测试修改' })
  assert.equal(res.ok, true)
  assert.equal(res.version, 2)
  const row = store.getUnit(id)
  assert.equal(row.content, '新文案')
  assert.equal(row.version, 2)
  const hist = db.prepare('SELECT * FROM unit_history WHERE id = ?').all(id)
  assert.equal(hist.length, 1)
  assert.equal(hist[0].content, '旧文案')
  assert.equal(hist[0].reason, '测试修改')
  assert.equal(store.counts().changes, 2, '写入与修改各记一条变更')
  closeDb(db)
})

test('备份：VACUUM INTO 产出可打开的库，并按 keep 轮转', () => {
  const { db, store } = freshStore()
  store.insertUnit({ track: 'memory', scope: 'global', content: '需要被备份的内容' })
  const dir = tmp()
  const day = (n) => new Date(2026, 0, n)
  for (let d = 1; d <= 9; d += 1) backupDaily(db, dir, { keep: 7, now: day(d) })
  const files = readdirSync(dir).sort()
  assert.equal(files.length, 7, '应只保留 7 份')
  assert.equal(files[0], 'mem-20260103.db', '最旧的应被清理')
  const latest = latestBackup(dir)
  assert.equal(latest.name, 'mem-20260109.db')

  const restored = openDb(join(dir, latest.name))
  const n = restored.prepare('SELECT COUNT(*) AS n FROM units').get().n
  assert.equal(Number(n), 1)
  assert.ok(existsSync(join(dir, latest.name)))
  closeDb(restored)
  closeDb(db)
})
