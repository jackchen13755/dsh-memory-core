import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { DEFAULT_CATEGORIES, PromptManager, expandVars, sanitizeSnapshotBody } from '../lib/prompts.js'
import { Store } from '../lib/store.js'

function fixture(seedFile = null) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-prompts-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const pm = new PromptManager(store, seedFile ? { seedFile } : {})
  return { db, store, pm }
}

test('变量展开与净化：{{date}}/{{time}} 展开，残留 {{}} 必须拆掉（否则宿主模板渲染会抛）', () => {
  const out = expandVars('今天是 {{date}} {{time}}')
  assert.match(out, /\d{4}-\d{2}-\d{2}/)
  assert.match(out, /\d{2}:\d{2}/)

  const dirty = sanitizeSnapshotBody('保留 {{unknownVar}} 与 {{ bad }} 以及 {{ 未闭合')
  assert.ok(!dirty.includes('{{'), `不得残留 {{：${dirty}`)
  assert.ok(dirty.includes('{unknownVar}'))
})

test('库：创建/查询/更新/启停/删除 + 分类', () => {
  const { db, pm } = fixture()
  const created = pm.createPrompt({ name: '测试提示词', summary: '一句话', category: '测试', tags: ['a'], body: '正文内容' })
  assert.equal(created.ok, true)
  const got = pm.getPrompt(created.id)
  assert.equal(got.name, '测试提示词')
  assert.deepEqual(got.tags, ['a'])
  assert.equal(got.enabled, true)

  assert.equal(pm.getPrompt('测试提示词').id, created.id, '可按名称查')
  assert.equal(pm.updatePrompt(created.id, { body: '改后的正文' }).ok, true)
  assert.equal(pm.getPrompt(created.id).body, '改后的正文')
  assert.equal(pm.setEnabled(created.id, false).ok, true)
  assert.equal(pm.listPrompts({ enabledOnly: true }).length, 0)
  assert.equal(pm.listPrompts({ q: '改后' }).length, 1, '按正文搜索')

  const cats = pm.listCategories().map((c) => c.name)
  for (const c of DEFAULT_CATEGORIES) assert.ok(cats.includes(c), `缺默认分类 ${c}`)
  assert.equal(pm.addCategory('自定义').ok, true)
  assert.equal(pm.removeCategory('自定义').ok, true)

  assert.equal(pm.deletePrompt(created.id).ok, true)
  assert.equal(pm.getPrompt(created.id), null)
  closeDb(db)
})

test('注入轨：一次性用尽即移除；间隔注入按 every 推进；无限注入不自动过期', () => {
  const { db, pm } = fixture()
  // 一次性：rounds=1, every=1
  const once = pm.createInjection({ title: '一次性规则', content: '只出现一次', rounds: 1, every: 1 })
  assert.equal(once.ok, true)
  assert.equal(pm.renderSection(null).includes('一次性规则'), true, '第一轮就该出现')
  pm.tickTurn(null)
  assert.equal(pm.renderSection(null).includes('一次性规则'), false)
  assert.equal(pm.listInjections({ activeOnly: true }).length, 0, '出现一次后移除')

  // 间隔 0 = 只出现一次
  pm.createInjection({ title: '间隔零', content: 'x', rounds: 5, every: 0 })
  assert.equal(pm.renderSection(null).includes('间隔零'), true)
  pm.tickTurn(null)
  assert.equal(pm.listInjections({ activeOnly: true }).length, 0)

  // 每 3 回合出现一次：出现 → 等 2 轮 → 再出现
  pm.createInjection({ title: '间隔三', content: 'y', rounds: 2, every: 3 })
  assert.equal(pm.renderSection(null).includes('间隔三'), true)
  pm.tickTurn(null)
  assert.equal(pm.renderSection(null).includes('间隔三'), false, '等待轮不出现')
  pm.tickTurn(null)
  assert.equal(pm.renderSection(null).includes('间隔三'), false)
  pm.tickTurn(null)
  assert.equal(pm.renderSection(null).includes('间隔三'), true, '第 3 回合再次出现')
  pm.tickTurn(null)
  assert.equal(pm.listInjections({ activeOnly: true }).length, 0, '两次用尽后移除')

  // 无限（rounds=0）：持续出现，不自动过期
  pm.createInjection({ title: '持续规则', content: 'z', rounds: 0, every: 1 })
  for (let i = 0; i < 5; i += 1) {
    assert.equal(pm.renderSection(null).includes('持续规则'), true)
    pm.tickTurn(null)
  }
  assert.equal(pm.listInjections({ activeOnly: true }).length, 1)
  assert.equal(pm.stopAll().stopped, 1, '需手动停止')
  closeDb(db)
})

test('注入作用域：会话级注入只在该会话渲染', () => {
  const { db, pm } = fixture()
  pm.createInjection({ title: 'A 会话规则', content: 'x', rounds: 0, every: 1, sessionId: 's-a' })
  pm.createInjection({ title: '全局规则', content: 'y', rounds: 0, every: 1, sessionId: null })
  const a = pm.renderSection('s-a')
  const b = pm.renderSection('s-b')
  assert.ok(a.includes('A 会话规则') && a.includes('全局规则'))
  assert.ok(!b.includes('A 会话规则') && b.includes('全局规则'))
  closeDb(db)
})

test('段渲染：文案是给模型的指令（含「必须遵循」标题、不暴露机制），且不含宿主可解析的 {{}}', () => {
  const { db, pm } = fixture()
  pm.createInjection({ title: '规格先行', content: '先写 Spec，再实现。今天是 {{date}}，遗留 {{unknown}}', rounds: 1, every: 1 })
  const text = pm.renderSection(null)
  assert.ok(text.includes('【用户规则（必须遵循）】'))
  assert.ok(text.includes('「规格先行」'))
  assert.ok(!text.includes('{{'), '进入段之前必须净化')
  assert.ok(!/注入|snapshot|机制/.test(text), '不暴露机制说明')
  closeDb(db)
})

test('种子库导入：首次写入、重复导入不覆盖', () => {
  const seed = join(mkdtempSync(join(tmpdir(), 'memcore-seed-')), 'prompts-seed.json')
  writeFileSync(
    seed,
    JSON.stringify({ categories: ['需求'], prompts: [{ name: '种子A', summary: 's', category: '需求', tags: [], body: 'b' }] }),
  )
  const { db, pm } = fixture(seed)
  const first = pm.importSeed()
  assert.equal(first.imported, 1)
  const again = pm.importSeed()
  assert.equal(again.imported, 0)
  assert.equal(pm.listPrompts({}).length, 1)
  closeDb(db)
})

test('旧插件提示词库导入（兼容 prompts.json 形状）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'memcore-legacy-prompts-')), 'prompts.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      categories: ['内置', '临时'],
      prompts: [
        { name: '旧提示词', description: '旧简介', category: '内置', tags: ['legacy'], content: '旧正文' },
        { name: '第二条', category: '临时', content: '正文2' },
      ],
    }),
  )
  const { db, pm } = fixture()
  const res = pm.importLegacy(file)
  assert.equal(res.ok, true)
  assert.equal(res.imported, 2)
  const imported = pm.getPrompt('旧提示词')
  assert.equal(imported.summary, '旧简介')
  assert.equal(imported.body, '旧正文')
  assert.equal(imported.source, 'import')
  closeDb(db)
})

test('注入会累计提示词使用次数', () => {
  const { db, pm } = fixture()
  const created = pm.createPrompt({ name: '计数提示词', body: '正文' })
  pm.createInjection({ promptId: created.id, title: '计数提示词', content: '正文', rounds: 1, every: 1 })
  assert.equal(pm.getPrompt(created.id).uses, 1)
  closeDb(db)
})
