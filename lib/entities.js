/**
 * 实体抽取（元数据的一部分，供 C2 稀疏语义通道加权）。
 * 抽路径 / 组件名 / 命令 / bug 号 —— 这些是"换个说法问同一件事"时最可靠的锚点。
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
