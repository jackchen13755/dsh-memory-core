import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb, quickCheck } from '../lib/db.js'
import { exportSnapshot, diffSnapshot } from '../lib/snapshot.js'
import { Store } from '../lib/store.js'

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function write(file, text) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/** 造一个最小旧库（含五轨 + 乱序追加，专门盯"顺序必须原样回放"）。 */
function makeLegacyFixture(root) {
  write(
    join(root, 'MEMORY.md'),
    ['[2026-01-01] 规则：提交前必须跑 lint。', '§', '[2026-01-02] 环境：node 版本 26。'].join('\n') + '\n',
  )
  write(join(root, 'USER.md'), '[2026-01-01] 用户偏好中文回复。\n')
  write(join(root, 'daily/2026-01-03.md'), ['[09:00] [dsh] 上午做了 A。', '§', '[14:00] [dsh] 下午做了 B。'].join('\n') + '\n')
  write(
    join(root, 'projects/abc123def456/MEMORY.md'),
    ['[2026-01-04] 先写的一条。', '§', '[2026-01-02] 后追加但时间更早的一条（顺序必须保持）。'].join('\n') + '\n',
  )
  write(join(root, 'projects/abc123def456/KEY.md'), '[2026-01-04] [summary:项目约定摘要]\n项目约定正文。\n')
  write(join(root, 'TODOS-work.md'), '[q1] [due: 2026-02-01] [pending] 写周报\n')
  write(join(root, 'SUGGESTIONS.jsonl'), `${JSON.stringify({ kind: 'memory', target: 'memory', payload: { content: '建议条目' }, createdAt: 1767225600000 })}\n`)
  write(join(root, 'skills/demo-skill/SKILL.md'), '---\nname: demo-skill\ndescription: 演示技能\n---\n\n正文\n')
  return root
}

test('导入 → 导出 是字节级可逆的（含乱序追加）', async () => {
  const legacy = makeLegacyFixture(tmp('memcore-legacy-'))
  const dbFile = join(tmp('memcore-db-'), 'mem.db')
  const db = openDb(dbFile)
  migrate(db)
  const store = new Store(db)

  const { importLegacy } = await import('../lib/legacy-import.js')
  const report = importLegacy(store, { dir: legacy, skillsRoot: join(legacy, 'skills'), log: () => {} })
  assert.equal(report.errors.length, 0)
  assert.equal(report.units.inserted, 8)
  assert.deepEqual(report.units.byTrack, { memory: 2, user: 1, daily: 2, project: 2, key: 1 })
  assert.equal(report.todos.inserted, 1)
  assert.equal(report.suggestions.inserted, 1)
  assert.equal(report.skills.inserted, 1)

  const out = tmp('memcore-out-')
  exportSnapshot(store, { dir: out, log: () => {} })
  const diff = diffSnapshot(out, legacy, {
    files: ['MEMORY.md', 'USER.md', 'daily/2026-01-03.md', 'projects/abc123def456/MEMORY.md', 'projects/abc123def456/KEY.md'],
  })
  for (const f of diff.files) assert.equal(f.status, 'same', `${f.path} 应字节一致（${f.detail ?? ''}）`)
  assert.ok(diff.ok)

  closeDb(db)
  rmSync(legacy, { recursive: true, force: true })
})

test('重复导入幂等（第二次全部 skipped，不产生重复条目）', async () => {
  const legacy = makeLegacyFixture(tmp('memcore-legacy2-'))
  const dbFile = join(tmp('memcore-db2-'), 'mem.db')
  const db = openDb(dbFile)
  migrate(db)
  const store = new Store(db)
  const { importLegacy } = await import('../lib/legacy-import.js')

  importLegacy(store, { dir: legacy, skillsRoot: join(legacy, 'skills'), log: () => {} })
  const second = importLegacy(store, { dir: legacy, skillsRoot: join(legacy, 'skills'), log: () => {} })
  assert.equal(second.units.inserted, 0)
  assert.equal(second.units.skipped, second.units.total)
  assert.equal(store.counts().units, 8)

  closeDb(db)
  rmSync(legacy, { recursive: true, force: true })
})

test('kind 启发式与实体抽取', async () => {
  const { inferKind, extractEntities } = await import('../lib/legacy-import.js')
  assert.equal(inferKind('提交前必须跑 lint', 'memory'), 'rule')
  assert.equal(inferKind('根因是选择器权重不够', 'memory'), 'pitfall')
  assert.equal(inferKind('今天做了什么', 'daily'), 'progress')
  const ents = extractEntities('用 `pnpm test` 跑 ~/.local/bin/tool，涉及 @/components/Foo 与 bug 12345')
  assert.ok(ents.includes('pnpm test'))
  assert.ok(ents.some((e) => e.includes('/.local/bin/tool')))
  assert.ok(ents.includes('@/components/Foo'))
  assert.ok(ents.includes('bug12345'))
})

test('导出文件可原样读回（快照目录 = 合法旧库目录）', async () => {
  const legacy = makeLegacyFixture(tmp('memcore-legacy3-'))
  const db = openDb(join(tmp('memcore-db3-'), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const { importLegacy } = await import('../lib/legacy-import.js')
  importLegacy(store, { dir: legacy, skillsRoot: null, log: () => {} })
  const out = tmp('memcore-out3-')
  exportSnapshot(store, { dir: out, log: () => {} })

  const db2 = openDb(join(tmp('memcore-db3b-'), 'mem.db'))
  migrate(db2)
  const store2 = new Store(db2)
  const restored = importLegacy(store2, { dir: out, skillsRoot: null, log: () => {} })
  assert.equal(restored.units.inserted, store.counts().units)
  closeDb(db)
  closeDb(db2)
  rmSync(legacy, { recursive: true, force: true })
})
