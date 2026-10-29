import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { EVOLVE_DEFAULTS, reinforce, runEvolution } from '../lib/evolution.js'
import { Store } from '../lib/store.js'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-wire-')), 'mem.db'))
  migrate(db)
  return { db, store: new Store(db) }
}

test('R5 接线：runEvolution 的 artifacts 步骤必须真的成功（不能静默抛错）', async () => {
  const { db, store } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'memcore-wire-art-'))
  const file = join(dir, 'schema.js')
  writeFileSync(file, 'version 1')
  const unit = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: `迁移在 \`${file}\`。` })

  const report = await runEvolution({ store, config: { ...EVOLVE_DEFAULTS, artifactCwd: dir } })
  const step = report.steps.find((s) => s.step === 'artifacts')
  assert.ok(step, '必须有 artifacts 步骤')
  assert.equal(step.ok, true, `artifacts 步骤不得失败：${JSON.stringify(step)}`)

  // 关键：不能只验 steps，要验**副作用真的发生了**
  const state = store.getMeta(`artifact:${unit.id}`, null)
  assert.ok(state, '跑完巡演必须真的写下指纹状态（否则等于没接线）')
  assert.equal(JSON.parse(state).state, 'ok')
  closeDb(db)
})

test('M1：边水位不吞掉 LIMIT 之外的批次（600 批，两轮走完）', async () => {
  const { db, store } = fixture()
  const a = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '规则A：提交前跑 lint。' })
  const b = store.insertUnit({ track: 'memory', scope: 'global', kind: 'rule', content: '规则B：提交信息用中文。' })
  const ins = store.db.prepare(
    'INSERT INTO recall_log (ts, session_id, query, unit_id, channel, rank, score, injected, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  // 600 个不同 ts 批次，每批同一条边（a,b）
  const base = Date.now()
  for (let i = 0; i < 600; i += 1) {
    const ts = base + i
    ins.run(ts, 's1', 'q', a.id, 'lexical', 1, 0.9, 1, null)
    ins.run(ts, 's1', 'q', b.id, 'lexical', 2, 0.9, 1, null)
  }
  const first = reinforce({ store })
  assert.equal(first.edges, 500, `第一轮应有 LIMIT 500，实际 ${first.edges}`)
  const second = reinforce({ store })
  assert.equal(second.edges, 100, `第二轮应处理剩余 100 批，实际 ${second.edges}`)
  const edge = store.db.prepare("SELECT weight FROM edges WHERE kind = 'coRetrieval'").get()
  assert.equal(Number(edge.weight), 600, `边权应累计 600，实际 ${edge?.weight}`)
  closeDb(db)
})

test('artifactCwd 有默认值，且能从 config 传进 runEvolution（相对路径才可能被核到）', async () => {
  const { EVOLVE_DEFAULTS } = await import('../lib/evolution.js')
  assert.equal(EVOLVE_DEFAULTS.artifactCwd, null, '默认 null = 只核绝对路径/~/')
  const { db, store } = fixture()
  const dir = mkdtempSync(join(tmpdir(), 'memcore-wire-cwd-'))
  const rel = 'lib/schema.js'
  const abs = join(dir, rel)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(abs, 'version 1')
  const unit = store.insertUnit({ track: 'memory', scope: 'global', kind: 'fact', content: `迁移在 \`${rel}\`。` })

  // 不配 artifactCwd：相对路径不判
  const r1 = await runEvolution({ store, config: { ...EVOLVE_DEFAULTS } })
  assert.equal(store.getMeta(`artifact:${unit.id}`, null), null, '无 cwd 时不应建立状态')

  // 配了 artifactCwd：相对路径被正确解析
  const r2 = await runEvolution({ store, config: { ...EVOLVE_DEFAULTS, artifactCwd: dir } })
  assert.equal(r2.steps.find((s) => s.step === 'artifacts')?.ok, true)
  assert.ok(store.getMeta(`artifact:${unit.id}`, null), '配了 cwd 后应建立指纹')
  closeDb(db)
})

test('nodes / node_edges 不进同步实体集（会话级派生态）', async () => {
  const { ENTITIES } = await import('../lib/sync.js')
  assert.ok(!ENTITIES.includes('node'), 'node 不得进 ENTITIES')
  assert.ok(!ENTITIES.includes('node_edge'), 'node_edge 不得进 ENTITIES')
  assert.deepEqual([...ENTITIES].sort(), ['skill', 'todo', 'unit'])
})
