/**
 * 宿主能力探测（**支持最新版 dsh** 的关键：不硬依赖、只探测）。
 *
 * 三条纪律：
 *   1. 版本只在启动时探测一次，失败不影响任何功能（只影响 `mem_status` 的展示）；
 *   2. 需要宿主服务一律走 `ctx.get(name)` + 可选注入，**绝不**把可选服务写进硬 `inject`
 *      （旧插件的教训：`inject` 里放 headless profile 不存在的服务会让整个插件加载失败）；
 *   3. 注册工具前先确认 `ctx.tools.register` 存在且可用，形状不符就跳过并记原因。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 本插件声明支持的 dsh 版本下限（与 npm latest 对齐）。 */
export const SUPPORTED_DSH = '>=0.1.5-rc.1'

/** 解析宿主 dsh 版本（best-effort，不抛）。 */
export function detectHostVersion() {
  for (const spec of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-tools/package.json']) {
    try {
      const url = import.meta.resolve(spec)
      const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
      return { version: pkg.version, via: spec }
    } catch {
      /* 换下一个候选 */
    }
  }
  return { version: null, via: null }
}

/** 语义化版本比较（含预发布标签：0.1.5-rc.2 > 0.1.5-rc.1，0.1.5 > 0.1.5-rc.9）。 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, ...pre] = String(v).split('-')
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre.join('-') }
  }
  const A = split(a)
  const B = split(b)
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i += 1) {
    const diff = (A.nums[i] ?? 0) - (B.nums[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (A.pre === B.pre) return 0
  if (A.pre === '') return 1 // 正式版 > 预发布
  if (B.pre === '') return -1
  const seg = (p) => p.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s))
  const [sa, sb] = [seg(A.pre), seg(B.pre)]
  for (let i = 0; i < Math.max(sa.length, sb.length); i += 1) {
    const x = sa[i]
    const y = sb[i]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1
    return String(x) > String(y) ? 1 : -1
  }
  return 0
}

/**
 * 探测宿主服务与 API 形状。
 *
 * ⚠️ 只能用 `ctx.get(name)` 取服务：cordis 的 context 代理对**未声明 inject** 的服务
 * 直接抛 `cannot get property "X" without inject`（本插件在 loader.create/热注入路径下
 * entry options 不带 inject，因此 `ctx.tools` 这种属性访问会当场炸掉整个 entry）。
 * @param {any} ctx cordis context
 */
export function probeHost(ctx) {
  const host = detectHostVersion()
  const get = (name) => {
    try {
      return ctx?.get?.(name)
    } catch {
      return undefined
    }
  }
  const tools = get('tools')
  const systemPrompt = get('systemPrompt')
  const commands = get('commands')
  const llm = get('llm')
  const caps = {
    tools: typeof tools?.register === 'function',
    systemPrompt: typeof systemPrompt?.context === 'function',
    commands: typeof commands?.register === 'function',
    llm: typeof llm?.stream === 'function',
    webserver: Boolean(get('webServer') ?? get('webserver')),
    sessionEvents: typeof ctx?.on === 'function',
  }
  const compatible = host.version ? compareVersions(host.version, '0.1.5-rc.1') >= 0 : null
  return { ...host, supported: SUPPORTED_DSH, compatible, caps }
}
