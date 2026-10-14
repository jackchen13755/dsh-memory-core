/**
 * 实体抽取与归一化（元数据的一部分，供 C2 稀疏语义通道加权）。
 * 抽路径 / 组件名 / 命令 / bug 号 —— 这些是"换个说法问同一件事"时最可靠的锚点。
 *
 * 归一化的用途：召回的实体通道过去用**裸字符串**比较（lib/recall.js 里
 * `doc.ents.has(ent)` / `includes`），大小写、全角、多余空白、`\` 与 `/`
 * 的写法差异都会漏命中。normalizeEntity 把两侧折成同一个规范键，再做两档匹配
 * （精确 / 包含，见 entityMatches）。
 */
export function extractEntities(text, { limit = 24 } = {}) {
  const out = new Set()
  const s = String(text ?? '')
  for (const m of s.matchAll(/`([^`\n]{2,80})`/g)) out.add(m[1])
  for (const m of s.matchAll(/(?:~\/|\/Users\/)[^\s，。；、）)】"']+/g)) out.add(m[0])
  for (const m of s.matchAll(/@\/[\w./-]+/g)) out.add(m[0])
  for (const m of s.matchAll(/\bbug[\s#]*(\d{3,7})\b/gi)) out.add(`bug${m[1]}`)
  for (const m of s.matchAll(/\b[a-z][a-z0-9]*(?:[-._][a-z0-9]+)+\b/g)) out.add(m[0])
  return [...out].slice(0, limit)
}

/**
 * 把实体折成规范键（幂等：normalizeEntity(normalizeEntity(x)) === normalizeEntity(x)）。
 *
 *   - 转小写（先做 NFC，避免 "Ａ" 的组合形两种写法折出不同结果）；
 *   - 去掉首尾空白、把内部连续空白折成一个空格；
 *   - 全角 ASCII（U+FF01–FF5E）转半角，全角空格 U+3000 转半角空格；
 *   - 路径分隔符统一为 `/`（`\` → `/`，连续 `/` 折叠成一个，含 UNC 的 `\\`）；
 *   - 盘符前缀去掉（`C:\Users\x` 与 `/Users/x` 折成同一个键）；`~/`（家目录）与
 *     `@/`（别名路径）保留前缀，不折成绝对路径；
 *   - 去掉尾部斜杠；根 `/` 保留（不会折成空串）。
 *
 * 纯函数：不依赖 store、不做 I/O、不改动入参。
 */
export function normalizeEntity(s) {
  let out = String(s ?? '').normalize('NFC')
  out = out.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  out = out.replace(/\u3000/g, ' ')
  out = out.replace(/\s+/g, ' ').trim().toLowerCase()
  if (out.includes('\\')) out = out.replace(/\\/g, '/')
  if (out.includes('/')) {
    // `~/`（家目录）与 `@/`（别名路径）保留前缀；盘符（`c:/`）丢弃 —— 目标是让
    // `c:\Users\x`、`/Users/x`、`／ＵＳＥＲＳ／ｘ` 折成同一个键。单字母才可能是盘符（不误伤 `12:30`）。
    const keepPrefix = out.startsWith('~/') ? '~' : out.startsWith('@/') ? '@' : null
    const dropPrefix = keepPrefix === null && /^[a-z]:\//.test(out)
    const body = keepPrefix !== null || dropPrefix ? out.slice(2) : out
    // 段内空白一并折掉、空段丢弃，保证"逐段重建"本身是不动点（`/c \` 与 `//@ \t＼` 都要收敛）
    const segments = body
      .split('/')
      .map((seg) => seg.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('/')
    out = `${keepPrefix ?? ''}/${segments}`
    out = out.replace(/\/+$/, '') || '/'
  }
  return out
}

/**
 * 实体匹配（走归一化键，而不是裸字符串）：
 *   ① 归一化后精确相等 → 命中；
 *   ② 否则任何一侧包含另一侧 → 命中（别名/换写法，对齐 recall 里"部分包含"那一档）。
 *
 * 空 query 或空文档实体永不命中（避免空键把一切都匹配上）。
 */
export function entityMatches(queryEntity, docEntities = []) {
  const q = normalizeEntity(queryEntity)
  if (!q) return false
  const list = Array.isArray(docEntities) ? docEntities : [docEntities]
  for (const doc of list) {
    const d = normalizeEntity(doc)
    if (!d) continue
    if (d === q) return true
    if (d.includes(q) || q.includes(d)) return true
  }
  return false
}
