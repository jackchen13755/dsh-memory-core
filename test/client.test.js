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
