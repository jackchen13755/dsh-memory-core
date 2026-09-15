/**
 * 分词与查询构造（设计 §4.1 / §6.1 C1 通道）。
 *
 * 两条硬事实（本机实测，见设计附录 B）：
 *   1. SQLite 的 unicode61 分词器把整段连续中文当一个 token，无法部分匹配
 *      → 入库前把相邻汉字切成 bigram；
 *   2. CJK bigram 查询**必须用 OR 连接**：`底部按钮怎么加` 对 `…底部按钮直接用…`
 *      隐式 AND 是 0 命中（`钮怎`/`怎么`/`么加` 不存在），显式 OR 才命中。
 *
 * 标识符（路径 / 包名 / 报错码 / 组件名）保原样入库，同时拆出分段词，
 * 保证 `@/components/FooterButton` 既能整串命中也能被 `footerbutton` 命中。
 */

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'
const CJK_RUN = new RegExp(`[${CJK}]+`, 'g')
const ASCII_RUN = /[A-Za-z0-9_@~$./\\:-]{2,}/g
const DIGITS = /\d{2,}/g

/** 切成 bigram（长度为 1 的连续段保留其单字）。 */
export function cjkBigrams(text) {
  const out = []
  for (const run of String(text ?? '').match(CJK_RUN) ?? []) {
    if (run.length === 1) out.push(run)
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
  }
  return out
}

/**
 * 把一段文本切成索引词条（去重、保序）。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const s = String(text ?? '')
  const seen = new Set()
  const push = (t) => {
    if (t && !seen.has(t)) seen.add(t)
  }
  for (const g of cjkBigrams(s)) push(g)
  for (const raw of s.match(ASCII_RUN) ?? []) {
    const t = raw.toLowerCase()
    push(t)
    for (const part of t.split(/[^a-z0-9]+/)) {
      if (part.length >= 2) push(part)
    }
  }
  for (const n of s.match(DIGITS) ?? []) push(n)
  return [...seen]
}

/** 空格连接的索引串（写进 `units.tokens`，由 FTS5 消费）。 */
export function tokensField(text) {
  return tokenize(text).join(' ')
}

/** FTS5 字面量：双引号包裹并转义内部引号，避免语法错误。 */
export function ftsLiteral(term) {
  return `"${String(term).replace(/"/g, '""')}"`
}

/**
 * 构造 FTS5 MATCH 查询串：所有词条**以 OR 连接**（见文件头第 2 条硬事实）。
 * @param {string} text
 * @param {{ maxTerms?: number }} [opts]
 */
export function ftsQuery(text, opts = {}) {
  const maxTerms = opts.maxTerms ?? 40
  const terms = tokenize(text).slice(0, maxTerms)
  if (terms.length === 0) return null
  return terms.map(ftsLiteral).join(' OR ')
}
