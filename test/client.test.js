import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

test('客户端清单：exports["./client"] + dsh.client 平台与注入声明', () => {
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(pkg.dsh.client, '缺少 dsh.client 声明（client-modules 不会注册）')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))
})

test('客户端产物形态：window.__ModuleLoader__.load({id, factory}) 信封', () => {
  // 允许前置注释（浏览器求值无害）；首个语句必须是加载器信封
  const stripped = client.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '')
  assert.ok(stripped.trimStart().startsWith('window.__ModuleLoader__.load({'), '首个语句必须是模块加载器信封')
  assert.ok(client.includes("id: 'dsh-memory-core'"), 'id 必须是包名')
  assert.ok(/factory:\s*\(require\)\s*=>/.test(client), '必须导出 factory(require)')
  // 不是 ESM（客户端按 CJS 工厂加载）
  assert.ok(!/^\s*import\s/m.test(client), '客户端产物不得含 ESM import')
  assert.ok(!/export\s+(const|function|default)/.test(client), '客户端产物不得含 ESM export')
})

test('客户端只 require 白名单模块（与官方客户端插件同款）', () => {
  const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-runtime'])
  const required = [...client.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
  assert.ok(required.length > 0, '至少 require react')
  for (const spec of required) {
    assert.ok(allowed.has(spec) || spec.startsWith('@deepseek-ai/dsh-client-'), `未在白名单的模块：${spec}`)
  }
})

test('客户端注册的 Tab 与红点角标契约', () => {
  assert.ok(client.includes("name: 'conversation.view'"), '必须注册到 conversation.view 槽位')
  assert.ok(client.includes("id: 'memory-hub'"))
  assert.ok(/label:\s*\(\)\s*=>/.test(client), 'label 必须是函数（红点靠它重注册）')
  assert.ok(client.includes("'/memory-core/api'") && client.includes("api('/badge'"), '红点计数来自宿主 badge 路由')
  assert.ok(client.includes('setInterval'), '需要轮询刷新角标')
})

test('React 状态声明：必须是成对解构且 setter 带 set 前缀（历史 bug：拆成两次 useState）', () => {
  // 曾经写成 `const x = st(v)[0]` + `const setX = st(v)[1]` —— 那是**两次独立的 useState**，
  // setter 写进幽灵槽位，表现为"点了没反应 + 永远加载中"。这条测试把它钉死。
  assert.ok(!/=\s*st\([^)]*\)\[\d\]/.test(client), '不得用 st(v)[0]/[1] 取状态（会变成两次 useState）')
  for (const m of client.matchAll(/const \[(\w+), (\w+)\] = st\(/g)) {
    assert.ok(m[2].startsWith('set') && m[2] === `set${m[1][0].toUpperCase()}${m[1].slice(1)}`, `setter 命名不对：${m[0]}`)
  }
  // 每个 setX 都必须在文件里真实存在（防止改名漏改调用点）
  const setters = new Set([...client.matchAll(/const \[\w+, (\w+)\] = st\(/g)].map((m) => m[1]))
  // 使用形式可能是直接调用 setX(...)，也可能是作为回调传递（onNotice: setNotice）
  for (const name of setters) {
    const uses = client.split(name).length - 1
    assert.ok(uses >= 2, `setter 声明后从未被使用：${name}`)
  }
})

test('每个 setX 都必须有对应声明（历史 bug：调用 setFullText 但没声明 → 渲染抛错、面板空白）', () => {
  const declared = new Set([...client.matchAll(/const \[\w+, (set\w+)\] = st\(/g)].map((m) => m[1]))
  const used = new Set([...client.matchAll(/\b(set[A-Z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]))
  const builtins = new Set(['setInterval', 'setTimeout', 'setImmediate', 'setProperty'])
  const missing = [...used].filter((name) => !declared.has(name) && !builtins.has(name))
  assert.deepEqual(missing, [], `这些 setter 被调用但没有声明：${missing.join(', ')}`)
})

test('面板交互契约：子 Tab（待确认/待办/技能/提示词 + 五轨）+ 美观/纯文本 + 搜索', () => {
  for (const piece of ["featureTab('queue'", "featureTab('todos'", "featureTab('skills'", "featureTab('prompts'"]) {
    assert.ok(client.includes(piece), `缺少功能页签：${piece}`)
  }
  for (const title of ['长期记忆', '用户档案', '项目关键记忆', '项目日志', '每日日志']) {
    assert.ok(client.includes(title), `缺少文件页签：${title}`)
  }
  assert.ok(client.includes('美观视图') && client.includes('纯文本视图'), '缺少视图切换')
  assert.ok(client.includes('memcore-search'), '缺少搜索框')
  assert.ok(client.includes("api('/todos'") && client.includes("api('/skills'"), '待办/技能面板需接宿主路由')
  assert.ok(client.includes('memcore-entry-ops'), '条目卡片需带操作区（编辑/归档/完成）')
  assert.ok(client.includes('加载失败：'), '加载失败要有可见错误而不是卡在加载中')
})


// ── 待确认队列：只按会话展示 + 归档可查（线上 bug 的根因在客户端的落点）─────────
// bug①：工具写入的建议 session_id 为 NULL（服务端已修），面板侧必须始终显式带会话过滤 ——
//        漏传 = 宿主的 `all`（全库），跨会话混看再采纳 = 条目落到别的会话/项目里；
// bug②：「归档」只发不收（从前端根本没有入口把归档的建议查回来）。
/** 在 vm 里求值客户端信封，取出 factory 暴露的模块对象（惰性才用到 document，无需 DOM）。 */
function loadClientModule() {
  const fakeReact = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (v) => ({ current: v }), Fragment: 'Fragment' }
  let captured = null
  const window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
  new Function('window', 'require', 'module', 'exports', client)(window, (spec) => (spec === 'react' ? fakeReact : {}), { exports: {} }, {})
  assert.ok(captured && captured.id === 'dsh-memory-core', '客户端信封必须注册 dsh-memory-core')
  return { mod: captured.factory((spec) => (spec === 'react' ? fakeReact : {})), fakeReact }
}

test('待确认队列：只查本会话（没有「全部」档），采纳带 sessionId', () => {
  const { mod, fakeReact } = loadClientModule()
  // sessionScopeOf / QueueView 都在 factory 闭包内不可直接取用：按源码契约验证
  // （拿不到会话时退 orphan，绝不省掉参数退化成宿主默认的 all）。
  const calls = [...client.matchAll(/api\('\/suggestions\?status=(pending|archived)&sessionId='\s*\+\s*([^\n]+)/g)]
    .map((m) => ({ status: m[1], expr: m[2].replace(/[),]+\s*$/, '') }))
  // 待确认列表（pending）+ 页签计数（pending）+ 已归档：每条都必须按会话
  assert.deepEqual([...new Set(calls.map((c) => c.status))].sort(), ['archived', 'pending'])
  for (const c of calls) {
    assert.ok(c.expr.startsWith('sessionScopeOf('), `每条查询都必须走 sessionScopeOf（漏传 = 全库）：${c.expr}`)
  }
  assert.ok(calls.some((c) => c.status === 'archived'), '缺少查「已归档」的请求：归档后就没地方找了')

  // 「全部」档必须彻底去掉：跨会话汇总再采纳，project/key 轨就会落到别的项目
  assert.ok(!client.includes('SCOPE_ALL'), '不得再有 SCOPE_ALL（不按会话过滤的档）')
  assert.ok(!/setScope\('all'\)/.test(client), '不得再有切「全部」的分段按钮')
  // 注释里会提到"没有『全部』档"这件事，只查真正会渲染出来的字面量
  const queueView = client
    .slice(client.indexOf('function QueueView'), client.indexOf('function PromptsView'))
    .replace(/^\s*\/\/.*$/gm, '')
  assert.ok(queueView.length > 0, '必须能定位到 QueueView 源码')
  assert.ok(!queueView.includes('全部'), '待确认视图里不得再出现「全部」')
  assert.ok(queueView.includes('本会话 (') && queueView.includes('已归档 ('), '只留「本会话 / 已归档」两段')

  // 采纳必须带当前会话 id：宿主按它反查「当前打开的项目」的作用域
  assert.ok(/api\('\/suggestions\/approve'[\s\S]{0,240}?sessionId: liveOf\(\)/.test(client), '采纳请求必须带 sessionId（project/key 轨落当前项目）')
  // 红点/页签计数同样按会话：否则角标 12 条、点进去 3 条
  assert.ok(client.includes("api('/badge' + badgeQuery("), '角标计数必须带当前会话过滤')
  assert.ok(client.includes("api('/suggestions?status=pending&sessionId=' + sessionScopeOf(live)"), '页签计数只数本会话')

  // 恢复动作接的是宿主 restore 路由；归档视图有独立空态
  assert.ok(client.includes("api('/suggestions/restore'"), '「已归档」视图必须有恢复动作（POST /suggestions/restore）')
  assert.ok(client.includes('已归档 (') && client.includes('没有已归档的待确认'), '需要「已归档」分段与空态文案')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof fakeReact.createElement, 'function')
})

// ── 「当前会话」解析（这一处曾经是本插件最要命的根因）─────────────────────────
// 客户端曾读 `ctx.sessions.list.getSnapshot().current`，而 DSH 的会话列表快照里**没有 current**
// （只有 ids/byId/phase/subagentsByParent/jobsBySession，官方包里零处这么读）→ 永远 null →
// 面板一律退化成 orphan：「本会话」永远空、条目全挤进「全部」，采纳时也拿不到当前项目。
// 官方口径 = 主视图正在展示的会话，即 retainedBy.mainView > 0（ui-workspace 三处同款）。
test('当前会话解析：走官方口径 retainedBy.mainView，绝不再读幻影字段 snapshot.current', () => {
  const { mod } = loadClientModule()
  const t = mod.__test
  assert.ok(t && typeof t.currentSessionIdOf === 'function', '客户端要暴露 currentSessionIdOf（纯函数）供契约测试')

  const list = {
    ids: ['session-a', 'session-b'],
    byId: {
      'session-a': { id: 'session-a', retainedBy: { mainView: 0 } },
      'session-b': { id: 'session-b', retainedBy: { mainView: 2 } },
    },
  }
  assert.equal(t.currentSessionIdOf(list), 'session-b', '当前会话 = retainedBy.mainView > 0 的那一个')
  assert.equal(t.currentSessionIdOf({ ids: [], byId: {}, phase: 'ready' }), null, '没有展示中的会话就返回 null')
  assert.equal(t.currentSessionIdOf(null), null, '拿不到快照要安全返回 null')
  assert.equal(t.currentSessionIdOf({ byId: {}, current: 'session-c' }), 'session-c', '宿主将来真给 current 也要认（兜底）')

  // 作用域哨兵：拿不到会话退 orphan，绝不省略参数（省略 = 宿主按全库数）
  assert.equal(t.sessionScopeOf('session-a'), 'session-a')
  assert.equal(t.sessionScopeOf(null), 'orphan')
  assert.equal(t.badgeQuery('session-a'), '?sessionId=session-a')

  // 源码层钉死：不得再读会话快照的 .current
  assert.ok(!/getSnapshot\(\)\.current/.test(client), '不得再读 snapshot.current（DSH 没有这个字段）')
  assert.ok(/retainedBy\.mainView/.test(client), '必须用 retainedBy.mainView 认当前会话')
  assert.ok(client.includes('拿不到当前会话 id'), '解析不出会话时要有可见提示，而不是静默空列表')
})
