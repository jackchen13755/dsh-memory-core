import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeDb, migrate, openDb } from '../lib/db.js'
import { parseTodoEntry } from '../lib/markdown.js'
import { SkillManager, parseSkill, setFrontmatterFlag } from '../lib/skills.js'
import { Store } from '../lib/store.js'
import { TodoManager, stampTodoLine } from '../lib/todos.js'

const CWD = '/tmp/example-workspace'

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-m4-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  return { db, store, todos: new TodoManager(store) }
}

const day = (offset) => {
  const d = new Date(Date.now() + offset * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

test('待办：四轨落库（项目轨按 cwd 隔离、每日轨带日期）', () => {
  const { db, todos } = fixture()
  const life = todos.add({ content: '买咖啡豆', track: 'life' })
  const work = todos.add({ content: '写周报', track: 'work', due: day(2) })
  const project = todos.add({ content: '修缺陷 12345', track: 'project', cwd: CWD })
  const daily = todos.add({ content: '今天复盘', track: 'daily', date: day(0) })
  assert.equal(life.ok && work.ok && project.ok && daily.ok, true)
  assert.equal(project.scope, 'project:1a264d53adb3')
  assert.equal(daily.day, day(0))
  const stats = todos.stats()
  assert.deepEqual(stats.byTrack, { life: 1, work: 1, project: 1, daily: 1 })
  closeDb(db)
})

test('待办：智能视图只给需要关注的（逾期 / 今日到期 / 本项目 / q1），最多 8 条', () => {
  const { db, todos } = fixture()
  todos.add({ content: '逾期的活', track: 'work', due: day(-2) })
  todos.add({ content: '今天到期', track: 'work', due: day(0) })
  todos.add({ content: '本项目的活', track: 'project', cwd: CWD })
  todos.add({ content: '别的项目的活', track: 'project', cwd: '/tmp/other' })
  todos.add({ content: '重要且紧急', track: 'work', important: true, urgent: true })
  todos.add({ content: '很远的事', track: 'work', due: day(30) })

  const view = todos.list({ cwd: CWD })
  const contents = view.map((t) => t.content)
  assert.ok(contents.includes('逾期的活'))
  assert.ok(contents.includes('今天到期'))
  assert.ok(contents.includes('本项目的活'))
  assert.ok(contents.includes('重要且紧急'))
  assert.ok(!contents.includes('很远的事'), '未到期且不重要不进智能视图')
  assert.ok(view.length <= 8)

  const all = todos.list({ cwd: CWD, all: true })
  assert.equal(all.length, 6, 'all 返回全部未完成')
  closeDb(db)
})

test('待办：每日过往查询需要 past + expired（旧工具的坑）', () => {
  const { db, todos } = fixture()
  const yesterday = day(-1)
  todos.add({ content: '昨天没做完的事', track: 'daily', date: yesterday })
  todos.add({ content: '昨天做完的事', track: 'daily', date: yesterday })
  const [a, b] = todos.list({ track: 'daily', day: yesterday, all: true })
  todos.done(b.id)

  assert.equal(todos.list({ past: true }).length, 0, '只带 past 看不到未完成的过期遗留（默认被隐藏）')
  const withExpired = todos.list({ past: true, expired: true })
  assert.equal(withExpired.length, 1)
  assert.equal(withExpired[0].content, '昨天没做完的事')
  closeDb(db)
})

test('待办：done / update / remove 与完成时间；重复内容幂等', () => {
  const { db, todos } = fixture()
  const a = todos.add({ content: '同一件事', track: 'work' })
  const b = todos.add({ content: '同一件事', track: 'work' })
  assert.equal(b.ok, false, '同样内容同轨应去重')
  assert.equal(todos.done(a.id).ok, true)
  const row = todos.get(a.id)
  assert.equal(row.status, 'done')
  assert.ok(row.done_at)
  assert.equal(todos.update(a.id, { due: day(3), category: '交付' }).ok, true)
  assert.equal(todos.get(a.id).due, day(3))
  assert.equal(todos.remove(a.id).ok, true)
  assert.equal(todos.get(a.id), null)
  closeDb(db)
})

test('待办：模型自建走待确认队列，采纳后落地', () => {
  const { db, store, todos } = fixture()
  const sug = todos.suggest({ content: '模型建议：补一条回归测试', track: 'project', cwd: CWD, sessionId: 's1' })
  assert.equal(sug.status, 'queued')
  assert.equal(todos.stats().total, 0, '未采纳不落库')
  const pending = store.listSuggestions({ status: 'pending', kind: 'todo' })
  assert.equal(pending.length, 1)
  const res = todos.approveSuggestion({ id: sug.id })
  assert.equal(res.ok, true)
  assert.equal(todos.stats().total, 1)
  assert.equal(store.listSuggestions({ status: 'approved' }).length, 1)
  closeDb(db)
})

test('待办：落库失败不划勾（建议留在队列，改字段后重试）', () => {
  const { db, store, todos } = fixture()
  // 载荷里的轨道不合法 → 采纳时 add 失败（真实场景：模型给了未知轨道/重复条目）
  const bad = todos.suggest({ content: '模型建议：轨道写错了', track: 'nonsense', sessionId: 's1' })
  const denied = todos.approveSuggestion({ id: bad.id })
  assert.equal(denied.ok, false)
  assert.equal(store.db.prepare('SELECT status FROM suggestions WHERE id = ?').get(bad.id).status, 'pending', '失败不能划勾，否则卡片消失且无处找回')
  const fixed = todos.approveSuggestion({ id: bad.id, overrides: { track: 'work' } })
  assert.equal(fixed.ok, true, '改正轨道后重试应成功')
  assert.equal(todos.stats().total, 1)
  assert.equal(store.db.prepare('SELECT status FROM suggestions WHERE id = ?').get(bad.id).status, 'approved')
  closeDb(db)
})

test('待办：提醒行只报条数；落盘格式与旧插件一致（能被 legacy 解析器读回）', () => {
  const { db, todos } = fixture()
  assert.equal(todos.reminderLine({ cwd: CWD }), null, '没有待办时不给提醒行')
  todos.add({ content: '逾期的活', track: 'work', due: day(-1) })
  todos.add({ content: '今天到期', track: 'work', due: day(0) })
  const line = todos.reminderLine({ cwd: CWD })
  assert.ok(line.includes('逾期 1 条') && line.includes('今日到期 1 条'))

  const [row] = todos.list({ all: true, track: 'work' })
  const text = stampTodoLine(row, { time: Date.parse('2026-09-15T09:30:00') })
  assert.ok(text.startsWith('[2026-09-15 09:30] [id: '), `格式不符：${text.slice(0, 40)}`)
  const parsed = parseTodoEntry(text, { track: 'work' })
  assert.equal(parsed.id, row.id)
  assert.equal(parsed.content, '逾期的活')
  assert.equal(parsed.due, day(-1))
  closeDb(db)
})

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------

function skillFixture() {
  const dir = join(mkdtempSync(join(tmpdir(), 'memcore-skills-')), 'skills')
  mkdirSync(join(dir, 'code-review-expert'), { recursive: true })
  writeFileSync(
    join(dir, 'code-review-expert', 'SKILL.md'),
    '---\nname: code-review-expert\ndescription: 专家级代码评审\n---\n\n# 用法\n\n按清单评审。\n',
    'utf8',
  )
  mkdirSync(join(dir, 'user-extra'), { recursive: true })
  writeFileSync(join(dir, 'user-extra', 'SKILL.md'), '---\nname: user-extra\n---\n\n正文\n', 'utf8')
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-skillsdb-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const skills = new SkillManager(store, { dir })
  return { dir, db, store, skills }
}

test('技能：frontmatter 解析与开关写入（官方 disable-model-invocation）', () => {
  const parsed = parseSkill('---\nname: a\ndescription: b\n---\n\n正文')
  assert.equal(parsed.name, 'a')
  assert.equal(parsed.description, 'b')
  assert.equal(parsed.disabled, false)

  const off = setFrontmatterFlag('---\nname: a\ndescription: b\n---\n\n正文', 'disable-model-invocation', true)
  assert.ok(off.includes('disable-model-invocation: true'))
  assert.equal(parseSkill(off).disabled, true)
  const on = setFrontmatterFlag(off, 'disable-model-invocation', false)
  assert.ok(!on.includes('disable-model-invocation'))
  assert.equal(parseSkill(on).description, 'b', '其它字段必须保留')
  assert.equal(parseSkill(on).body.trim(), '正文')
})

test('技能：扫描建索引 / 列表 / 读取 / 启停（写文件）', () => {
  const { dir, db, skills } = skillFixture()
  const scan = skills.scan()
  assert.equal(scan.indexed, 2)
  assert.equal(skills.list({}).length, 2)

  const read = skills.read('code-review-expert')
  assert.equal(read.ok, true)
  assert.ok(read.body.includes('按清单评审'))
  assert.equal(read.description, '专家级代码评审')

  assert.equal(skills.setEnabled('code-review-expert', false).ok, true)
  const file = join(dir, 'code-review-expert', 'SKILL.md')
  assert.ok(readFileSync(file, 'utf8').includes('disable-model-invocation: true'), '禁用必须落到 frontmatter')
  assert.equal(skills.list({ enabledOnly: true }).length, 1)
  assert.equal(skills.setEnabled('code-review-expert', true).ok, true)
  assert.ok(!readFileSync(file, 'utf8').includes('disable-model-invocation'))
  assert.equal(skills.list({ enabledOnly: true }).length, 2)
  closeDb(db)
})

test('技能：create 校验命名与长度；update 保留 frontmatter；索引随之刷新', () => {
  const { db, skills } = skillFixture()
  assert.equal(skills.create({ name: 'Bad Name', body: 'x'.repeat(30) }).ok, false, '必须 kebab-case')
  assert.equal(skills.create({ name: 'ok-name', body: 'too short' }).ok, false, '正文太短')
  const created = skills.create({ name: 'demo-skill', description: '演示', body: '# 演示\n\n这是一段足够长的技能正文内容。' })
  assert.equal(created.ok, true)
  assert.equal(skills.list({ q: 'demo' }).length, 1)

  const upd = skills.update('demo-skill', { body: '# 演示\n\n改过的正文，依然足够长。', description: '改过的简介' })
  assert.equal(upd.ok, true)
  const read = skills.read('demo-skill')
  assert.ok(read.body.includes('改过的正文'))
  assert.equal(read.description, '改过的简介')
  closeDb(db)
})

test('技能：建议走待确认队列，采纳后写入技能库', () => {
  const { db, store, skills } = skillFixture()
  const sug = skills.suggest({ name: 'new-skill', description: '值得沉淀', body: '# 新技能\n\n正文足够长的一段说明文字。' })
  assert.equal(sug.status, 'queued')
  assert.equal(skills.pendingSuggestions().length, 1)
  const res = skills.approveSuggestion({ id: sug.id })
  assert.equal(res.ok, true)
  assert.equal(skills.read('new-skill').ok, true)
  assert.equal(store.listSuggestions({ status: 'approved', kind: 'skill' }).length, 1)
  closeDb(db)
})

test('技能：落盘失败不划勾（建议留在队列，可改名重试）', () => {
  const { db, store, skills } = skillFixture()
  const bad = skills.suggest({ name: 'Bad Name', description: '非法命名', body: '# 新技能\n\n正文足够长的一段说明文字。' })
  const denied = skills.approveSuggestion({ id: bad.id })
  assert.equal(denied.ok, false)
  assert.match(denied.message, /kebab-case/)
  assert.equal(store.db.prepare('SELECT status FROM suggestions WHERE id = ?').get(bad.id).status, 'pending', '失败不能划勾，否则卡片消失且无处找回')
  assert.equal(store.listSuggestions({ status: 'approved', kind: 'skill' }).length, 0)

  const fixed = skills.approveSuggestion({ id: bad.id, overrides: { name: 'good-name' } })
  assert.equal(fixed.ok, true, '改名后重试应成功')
  assert.equal(skills.read('good-name').ok, true)
  assert.equal(store.db.prepare('SELECT status FROM suggestions WHERE id = ?').get(bad.id).status, 'approved')
  closeDb(db)
})

test('技能：文件被手改后以文件为准（索引校正）', () => {
  const { dir, db, skills } = skillFixture()
  skills.scan()
  const file = join(dir, 'user-extra', 'SKILL.md')
  writeFileSync(file, '---\nname: user-extra\ndescription: 手改后的简介\n---\n\n手改正文\n', 'utf8')
  const read = skills.read('user-extra')
  assert.equal(read.description, '手改后的简介')
  const indexed = skills.list({ q: '手改' })
  assert.equal(indexed.length, 1, '读取时顺带校正索引')
  assert.ok(existsSync(file))
  closeDb(db)
})

// ---------------------------------------------------------------------------
// 自进化审查：提取链路里的技能候选
// ---------------------------------------------------------------------------

test('提取器：解析 skills 字段（命名/长度不合法或重复者被丢弃）', async () => {
  const { parseExtraction } = await import('../lib/extract.js')
  const raw = JSON.stringify({
    items: [{ content: '一条记忆', track: 'memory', kind: 'fact', confidence: 0.8 }],
    skills: [
      { name: 'fix-issue-flow', description: '缺陷单解决流程', body: '# 步骤\n1. 从链接取缺陷号\n2. 跑内部 CLI 提交解决\n3. 提交后校验状态是否为已解决', reason: '可复用' },
      { name: 'Bad Name', description: 'x', body: 'y'.repeat(80) },
      { name: 'too-short', description: 'x', body: '短' },
      { name: 'fix-issue-flow', description: '重复', body: 'z'.repeat(80) },
    ],
  })
  const parsed = parseExtraction(raw)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.skills.length, 1, `只保留合法且不重复的候选：${JSON.stringify(parsed.skills)}`)
  assert.equal(parsed.skills[0].name, 'fix-issue-flow')
  assert.equal(parsed.skills[0].reason, '可复用')
})

test('提取器：没有 skills 字段时返回空数组（不硬凑）', async () => {
  const { parseExtraction } = await import('../lib/extract.js')
  const parsed = parseExtraction(JSON.stringify({ items: [] }))
  assert.deepEqual(parsed.skills, [])
})

test('extractSession：技能候选走 enqueueSkill（零直写，只进队列）', async () => {
  const { closeDb, migrate, openDb } = await import('../lib/db.js')
  const { Store } = await import('../lib/store.js')
  const { extractSession } = await import('../lib/extract.js')
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'memcore-skillx-')), 'mem.db'))
  migrate(db)
  const store = new Store(db)
  const queued = []
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({
        items: [{ content: '用户偏好零直写', track: 'memory', kind: 'rule', confidence: 0.9 }],
        skills: [{ name: 'zero-write-memory', description: '记忆写入协议', body: '# 步骤\n1. 提取产物只进待确认队列\n2. 人工采纳后才写入记忆库\n3. 验证：未采纳时 mem_search 查不到', reason: '通用做法' }],
      }) }
    },
  }
  const res = await extractSession({
    store,
    transcript: 'x'.repeat(200),
    llm,
    route: { provider: 'p', model: 'm' },
    enqueue: (item) => { queued.push(item); return { status: 'queued' } },
    enqueueSkill: (cand) => { queued.push(cand); return { status: 'queued' } },
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.skillQueued, 1)
  assert.equal(queued.length, 2, '记忆 1 条 + 技能 1 条')
  assert.equal(queued[1].name, 'zero-write-memory')
  closeDb(db)
})

test('待办快照导出：TODOS-*.md 与日轨文件按旧格式落盘', async () => {
  const { exportSnapshot } = await import('../lib/snapshot.js')
  const { mkdtempSync: mk, readFileSync: rf } = await import('node:fs')
  const dir = mk(join(tmpdir(), 'memcore-snap-'))
  const { db, store, todos } = fixture()
  todos.add({ content: '写周报', track: 'work', due: day(1) })
  todos.add({ content: '买咖啡豆', track: 'life' })
  todos.add({ content: '修缺陷 12345', track: 'project', cwd: CWD })
  todos.add({ content: '今天复盘', track: 'daily', date: day(0) })
  const res = exportSnapshot(store, { dir })
  assert.equal(res.dir, dir)
  assert.ok(res.todos >= 4, `应导出 4 条待办，实际 ${res.todos}`)
  const work = rf(join(dir, 'TODOS-work.md'), 'utf8')
  assert.ok(work.includes('写周报') && work.includes('[id: '), work.slice(0, 120))
  assert.ok(rf(join(dir, 'TODOS-life.md'), 'utf8').includes('买咖啡豆'))
  assert.ok(rf(join(dir, `daily/${day(0)}.todo.md`), 'utf8').includes('今天复盘'))
  const paths = res.files.map((f) => (typeof f === 'string' ? f : f.path ?? f.rel ?? ''))
  const projectFiles = paths.filter((f) => f.startsWith('projects/') && f.endsWith('TODOS.md'))
  assert.equal(projectFiles.length, 1, `项目轨待办应落到 projects/<hash>/TODOS.md：${JSON.stringify(paths)}`)
  closeDb(db)
})
