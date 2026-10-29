/**
 * 产物失效核对（P2，2026-10-29，借鉴 dsh-soul 的 artifact 指纹思路）
 *
 * 问题：记忆里写着 `lib/schema.js 的 edges 表`，而那个文件后来被改了/删了 ——
 * 这条记忆仍在被召回，但它的**证据已经作废**。现在的 `units.content_hash` 只是
 * **内容去重指纹**（同内容不重复入库），并不表达「所指的外部对象是否还在」。
 *
 * 五条硬约束（逐条都有踩过的坑）：
 *   ① **advisory only**：只写状态，不改 importance、不改 status、不归档、不删除。
 *      判定失效是给人看的信号，不是删除授权（对齐 decay 的「只归档不删除」）。
 *   ② **不写 units.meta**：那一列是**同步载荷**（sync.js 整列替换），写进去会把
 *      「A 设备的绝对路径 + 文件哈希」同步给 B 设备，B 下一轮全部重基线、
 *      期间的真实漂移被静默接受。状态一律放 meta 表（`artifact:<unitId>`）。
 *   ③ **不进检索热路径**：只在 30 分钟一次的后台巡演里跑，召回 p95 预算 12ms 不能被磁盘 I/O 污染。
 *   ④ **路径受限**：只核对待核目录内、非软链、非敏感目录（.ssh/.aws/.gnupg/.env…）、
 *      单文件 ≤256KB、每轮总读取 ≤8MB。记忆正文来自模型写入，等于模型能决定读哪个文件，
 *      所以必须自己设栅栏（lstat 拒软链 + 白名单目录 + 字节预算）。
 *   ⑤ **轮转**：按稳定的 unit id 排序 + OFFSET 轮转，不按 rowid（VACUUM 后 rowid 可能重排），
 *      保证 1000+ 条的库最终都能被核对到，而不是永远只查最近 60 条。
 *
 * 诚实说明局限：首次核对是**建立基线**（记当时内容），不是「写入时内容」。
 * 文件若在第一次核对之前就变了，这次发现不了。真正的写入时指纹需要写到写入路径上，
 * 那会让 writeMemory 多一次磁盘 stat —— 本次刻意不做。
 */
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { extractEntities } from './entities.js'
import { sha1 } from './paths.js'

const MAX_FILE_BYTES = 256 * 1024
const DEFAULT_RUN_BYTES = 8 * 1024 * 1024
/** 敏感目录/文件：即便被记忆提到也不碰（存在性+哈希也是信息） */
const SENSITIVE = [/(^|\/)\.ssh\//, /(^|\/)\.aws\//, /(^|\/)\.gnupg\//, /(^|\/)\.config\/gcloud/, /credentials/i, /(^|\/)\.env(\.|$)/i, /id_rsa|id_ed25519|\.p12$|\.pfx$/i, /Library\/Keychains/, /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/]
/** 无哈希的哨兵值：单靠 null 会让「首轮就缺 / 超大」永远走"没见过"分支（真踩过） */
const SENTINEL_MISSING = 'MISSING'
const SENTINEL_SKIP = 'SKIP'

/** 保守的扩展名白名单：用来把 `zhe.chen` 这类点分小写词挡在门外。 */
const EXT_ALLOW = new Set('js mjs cjs ts tsx jsx json jsonc md mdx py go rs java kt rb php sql yml yaml toml ini cfg conf sh bash zsh ps1 css scss less html htm vue svelte txt lock env prisma graphql proto gradle xml plist'.split(' '))

/**
 * 看起来像"具体文件"的候选。
 *
 * 两道门（都是踩出来的）：① 必须**带目录分隔符**或**扩展名在白名单里** ——
 * 否则 `zhe.chen` 这类点分小写词会被当成文件、在给了 cwd 时解析成 `<cwd>/zhe.chen`；
 * ② 不能以反引号/引号/标点收尾 —— entities 的路径正则不排除反引号，
 * `\`~/proj/a.json\`` 会连尾反引号一起被抓出来，变成**永远不存在的第二条路径**，
 * 而这会被判成 missing 并永久粘住（本插件自己的记忆正文大量是反引号路径，实测真踩到）。
 */
function looksLikeFile(s) {
  const t = String(s ?? '').trim()
  if (t.length < 4 || t.length > 300) return false
  if (/\s/.test(t)) return false
  if (t.startsWith('http://') || t.startsWith('https://')) return false
  if (/[`'"）)】\]]$/.test(t)) return false // 尾随引号/括号/反引号 → 不是路径本体
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('~/')) return false // 协议/盘符噪声，除 ~/
  if (t.includes('/')) return true
  const m = t.match(/\.([A-Za-z][A-Za-z0-9]{0,6})$/)
  return Boolean(m && EXT_ALLOW.has(m[1].toLowerCase()))
}

/** 去掉包裹的引号/反引号与尾随标点，得到路径本体。 */
function trimPath(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^[`'"（(【\[]+/, '')
    .replace(/[`'"）)】\]，。；、,;:：]+$/, '')
    .replace(/^@\//, './')
    .trim()
}

/** 从一段正文里挑出候选文件路径（复用零模型实体抽取，再补两轮显式扫描）。 */
export function candidatePaths(text, { limit = 3 } = {}) {
  const out = []
  const seen = new Set()
  const push = (raw) => {
    const norm = trimPath(raw)
    if (!norm || !looksLikeFile(norm) || seen.has(norm)) return
    seen.add(norm)
    out.push(norm)
  }
  // ① 实体抽取（反引号 / ~/ / /Users/ 开头，限 80 字符）
  for (const ent of extractEntities(text, { limit: 24 })) push(ent)
  const s = String(text ?? '')
  // ② 反引号里的代码片段：extractEntities 有 80 字符上限，长路径会被漏掉
  for (const m of s.matchAll(/`([^`\n]{2,300})`/g)) push(m[1])
  // ③ 裸写的绝对路径（很多记忆里路径不加反引号）
  for (const m of s.matchAll(/(?:^|[\s(（、，,])((?:\/|~\/)[^\s`"'，。；、）)】\]]{4,300})/g)) push(m[1])
  return out.slice(0, limit)
}

function isSensitive(full) {
  return SENSITIVE.some((re) => re.test(full))
}

/** 路径是否在允许的根目录内（没有 cwd 时只允许 home 下的非敏感路径）。 */
function withinRoots(full, { cwd = null } = {}) {
  const roots = [homedir()]
  if (cwd) roots.push(resolve(cwd))
  return roots.some((root) => full === root || full.startsWith(root.endsWith(sep) ? root : root + sep))
}

/**
 * 把一个候选路径绝对化并探测。
 * @returns {null | {path: string, sha1: string|null, size: number|null, missing?: true, skipped?: string}}
 */
export function fingerprint(pathLike, { cwd = null, budget } = {}) {
  let full = null
  try {
    if (pathLike.startsWith('~/')) full = join(homedir(), pathLike.slice(2))
    else if (isAbsolute(pathLike)) full = pathLike
    else if (cwd) full = resolve(cwd, pathLike)
  } catch {
    return null
  }
  // 相对路径且没有 cwd：不判（约束 ④）
  if (!full) return null
  if (isSensitive(full)) return { path: full, sha1: null, size: null, skipped: 'sensitive' }
  if (!withinRoots(full, { cwd })) return { path: full, sha1: null, size: null, skipped: 'outside-root' }
  let st
  try {
    // lstat：软链一律不跟（避免 ~ 展开后被指向奇怪位置）
    st = lstatSync(full)
  } catch {
    return { path: full, sha1: null, size: null, missing: true }
  }
  if (st.isSymbolicLink()) return { path: full, sha1: null, size: null, skipped: 'symlink' }
  if (!st.isFile()) return null
  if (st.size > MAX_FILE_BYTES) return { path: full, sha1: null, size: st.size, skipped: 'too-large' }
  if (budget && budget.left <= 0) return { path: full, sha1: null, size: st.size, skipped: 'budget' }
  if (budget) budget.left -= st.size
  try {
    return { path: full, sha1: sha1(readFileSync(full)), size: st.size }
  } catch {
    return { path: full, sha1: null, size: st.size, skipped: 'unreadable' }
  }
}

function readState(store, unitId) {
  try {
    const raw = store.getMeta(`artifact:${unitId}`, null)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * 核对一批 unit 的产物指纹（轮转：按 unit id 排序 + OFFSET，覆盖全库）。
 *
 * @returns {{checked:number, units:number, baselined:number, changed:number, missing:number, skipped:number}}
 */
export function verifyArtifacts(store, { cwd = null, limit = 60, maxBytes = DEFAULT_RUN_BYTES } = {}) {
  const db = store.db
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM units WHERE status = 'active'").get()?.n ?? 0)
  if (total === 0) return { checked: 0, units: 0, baselined: 0, changed: 0, missing: 0, skipped: 0 }

  const offsetRaw = Number(store.getMeta('artifact_offset', '0')) || 0
  const offset = offsetRaw >= total ? 0 : offsetRaw
  // 按 id 排序（唯一且稳定，VACUUM 不会重排），OFFSET 轮转覆盖全库
  const rows = db
    .prepare("SELECT id, content FROM units WHERE status = 'active' ORDER BY id ASC LIMIT ? OFFSET ?")
    .all(limit, offset)
  const nextOffset = offset + rows.length >= total ? 0 : offset + rows.length
  store.setMeta('artifact_offset', String(nextOffset))

  const out = { checked: 0, units: rows.length, baselined: 0, changed: 0, missing: 0, skipped: 0 }
  const budget = { left: Math.max(0, Number(maxBytes) || DEFAULT_RUN_BYTES) }

  for (const row of rows) {
    const paths = candidatePaths(row.content, { limit: 3 })
    if (paths.length === 0) continue
    const prev = readState(store, row.id) ?? { state: 'ok', paths: {}, at: null }
    let dirty = false
    let missingAny = false
    let changedAny = false
    for (const p of paths) {
      const fp = fingerprint(p, { cwd, budget })
      if (!fp) continue
      out.checked += 1
      const has = Object.prototype.hasOwnProperty.call(prev.paths, fp.path)
      if (fp.skipped) {
        // 跳过项也记哨兵，避免每轮重复探测
        if (!has) {
          prev.paths[fp.path] = SENTINEL_SKIP
          dirty = true
        }
        out.skipped += 1
        continue
      }
      if (fp.missing) {
        missingAny = true
        if (prev.paths[fp.path] !== SENTINEL_MISSING) {
          prev.paths[fp.path] = SENTINEL_MISSING
          dirty = true
        }
        out.missing += 1
        continue
      }
      if (!has) {
        // 第一次见到：建立基线（诚实说明：这是"当前内容"，不是"写入时内容"）
        prev.paths[fp.path] = fp.sha1
        dirty = true
        out.baselined += 1
        continue
      }
      if (prev.paths[fp.path] !== fp.sha1) {
        prev.paths[fp.path] = fp.sha1
        changedAny = true
        dirty = true
        out.changed += 1
      }
    }
    if (dirty) {
      /**
       * 粘性状态：missing / changed 一旦成立就保持，直到人工处理（或 meta 被清）。
       * 不自动回落成 ok —— 「曾经失效过」本身就是需要人看一眼的信息，
       * 悄悄回 ok 会让这条信号在下一轮巡演里消失。
       */
      if (missingAny) prev.state = 'missing'
      else if (changedAny && prev.state !== 'missing') prev.state = 'changed'
      prev.at = Date.now()
      store.setMeta(`artifact:${row.id}`, JSON.stringify(prev))
    }
  }
  return out
}

/**
 * 统计（给 mem_status / 面板用的**消费方**：没有它，这套状态就只有写没有读）。
 * @returns {{ok:number, changed:number, missing:number, total:number}}
 */
export function artifactStats(store) {
  const out = { ok: 0, changed: 0, missing: 0, total: 0 }
  let rows = []
  try {
    rows = store.db.prepare("SELECT value FROM meta WHERE key LIKE 'artifact:%'").all()
  } catch {
    return out
  }
  for (const r of rows) {
    let st = null
    try {
      st = JSON.parse(r.value)?.state ?? null
    } catch {
      st = null
    }
    if (!st) continue
    out.total += 1
    if (st === 'changed') out.changed += 1
    else if (st === 'missing') out.missing += 1
    else out.ok += 1
  }
  return out
}
