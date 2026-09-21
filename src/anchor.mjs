// src/anchor.mjs — C6 第一版：压缩后确定性锚点校验（零 LLM、零新存储）。
//
// 借鉴 ICCuse/dsh-premise-guard 的做法：把「PIN 事实有没有真的进摘要」从猜测
// 变成可验证的字面包含比对。锚点只取确定性可抽取的字面量——文件路径、引号字面量、
// key=value、全大写常量/错误码——不做语义判断，因此不引入任何模型调用。
//
// 边界（诚实声明）：抽不出锚点的事实（纯自然语言偏好）无法校验，记为
// unverifiableFacts，不计入命中率——「没得验」不等于「验过了没丢」。

const DEFAULT_MAX_ANCHORS = 5
const DEFAULT_MIN_ANCHOR_LENGTH = 6

// 顺序敏感：Windows 绝对路径 → 带扩展名的相对/绝对路径（可含目录）→ 无扩展名的多段绝对路径。
// 注意 JS 正则是"最左优先"而非"最长"——带扩展名的那条必须排在裸路径之前，
// 否则 "src/store.mjs" 会先被 \/[\w.\-/]{4,} 截成 "/store.mjs"。
const PATH_RE = /(?:[A-Za-z]:\\[^\s，。；,;'"）)]{3,}|[\w.\-/]+\.(?:mjs|js|ts|tsx|json|md|ya?ml|py|rs|toml|sqlite3?|db)\b|\/[\w.-]+\/[\w.\-/]{2,})/g
const QUOTED_RE = /[「『"']([^「」『』"']{4,60})[」』"']/g
const KV_RE = /\b[\w.-]{2,}\s*=\s*[\w./-]{2,}/g
const CONST_RE = /\b[A-Z][A-Z0-9_]{3,}\b/g

/**
 * 从文本里确定性抽取字面锚点（顺序 = 优先级：路径 > 引号 > key=value > 常量）。
 * @param {string} text
 * @param {{maxAnchors?: number, minAnchorLength?: number}} [opts]
 * @returns {string[]}
 */
export function extractAnchors(text, opts = {}) {
  const max = Number.isInteger(opts.maxAnchors) ? opts.maxAnchors : DEFAULT_MAX_ANCHORS
  const minLen = Number.isInteger(opts.minAnchorLength) ? opts.minAnchorLength : DEFAULT_MIN_ANCHOR_LENGTH
  const src = String(text ?? '')
  const out = []
  const seen = new Set()
  const push = (v) => {
    const s = String(v ?? '').trim()
    if (s.length < minLen || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  for (const m of src.matchAll(PATH_RE)) push(m[0])
  for (const m of src.matchAll(QUOTED_RE)) push(m[1])
  for (const m of src.matchAll(KV_RE)) push(m[0])
  for (const m of src.matchAll(CONST_RE)) push(m[0])
  return out.slice(0, max)
}

/** 归一化：去所有空白 + 小写（摘要模型会改写换行与大小写，不该因此判丢）。 */
function normalize(s) {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase()
}

/**
 * 包含比对。
 * @param {string[]} anchors
 * @param {string} haystack
 * @returns {{hits: string[], missed: string[], total: number, ratio: number|null}}
 */
export function verifyAnchors(anchors, haystack) {
  const hay = normalize(haystack)
  const hits = []
  const missed = []
  for (const a of Array.isArray(anchors) ? anchors : []) {
    if (hay.includes(normalize(a))) hits.push(a)
    else missed.push(a)
  }
  const total = hits.length + missed.length
  return { hits, missed, total, ratio: total > 0 ? hits.length / total : null }
}

/**
 * PIN 事实清单 → 摘要文本 的命中报告。
 * @param {string[]} facts - collectPinnedFacts 的原始事实（不是渲染后的指令块）
 * @param {string} summaryText - 摘要正文
 * 2026-09-21（MAID-B12）：返回值补 `factsCount` / `verifiableFacts` / `verifiableRatio`——
 * 「16 条事实里只有 4 条抽得出锚点」这件事必须可见，否则命中率分母被悄悄换掉，
 * 0/4 与 4/4 看起来一样可信。
 * @param {{maxAnchors?: number, minAnchorLength?: number}} [opts]
 * @returns {{anchors: string[], hits: string[], missed: string[], total: number, ratio: number|null, unverifiableFacts: number, factsCount: number, verifiableFacts: number, verifiableRatio: number|null}}
 */
export function pinAnchorReport(facts, summaryText, opts = {}) {
  const list = Array.isArray(facts) ? facts : []
  const max = Number.isInteger(opts.maxAnchors) ? opts.maxAnchors : DEFAULT_MAX_ANCHORS
  const collected = []
  const seen = new Set()
  let unverifiableFacts = 0
  for (const f of list) {
    const a = extractAnchors(f, { ...opts, maxAnchors: max })
    if (a.length === 0) { unverifiableFacts += 1; continue }
    for (const x of a) { if (!seen.has(x)) { seen.add(x); collected.push(x) } }
  }
  const anchors = collected.slice(0, max)
  const v = verifyAnchors(anchors, summaryText)
  const factsCount = list.length
  const verifiableFacts = factsCount - unverifiableFacts
  return {
    anchors, hits: v.hits, missed: v.missed, total: v.total, ratio: v.ratio, unverifiableFacts,
    factsCount,
    verifiableFacts,
    verifiableRatio: factsCount > 0 ? verifiableFacts / factsCount : null,
  }
}

/**
 * MAID-B12（2026-09-21）：把「最近一次 PIN 校验」换成**近 N 次分布**。
 *
 * 动因是一手事故：调研时只查了最近 12 行（恰好全是 4/4）→ 误判「软保护 100% 有效」，
 * 而真实分布里 10.5% 是 0/4 全丢。只报最近一次 = 幸存者偏差。
 *
 * 兼容性：2026-09-21 之前写的行没有 hits/total，用 anchors/missed 反推（hits = anchors - missed）；
 * 这一步不能只看 missed.length——那会把「锚点本来就少」误算成「全丢掉」。
 * @param {Array<{op?: string, detail?: string}>} rows - audit.recent() 的结果（含非 pin 行，内部过滤）
 * @param {{maxRuns?: number}} [opts]
 * @returns {{runs: number, buckets: Array<{key: string, hits: number, total: number, n: number}>, zeroRuns: number, noAnchorRuns: number, facts: number, verifiableFacts: number, verifiableRatio: number|null}}
 */
export function summarizePinHistory(rows, opts = {}) {
  const maxRuns = Number.isInteger(opts.maxRuns) ? opts.maxRuns : 20
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.op === 'pin').slice(0, maxRuns)
  const byKey = new Map()
  let zeroRuns = 0
  let noAnchorRuns = 0
  let facts = 0
  let verifiableFacts = 0
  for (const r of list) {
    let d = null
    try { d = JSON.parse(String(r.detail ?? '')) } catch { d = null }
    if (!d || typeof d !== 'object') { noAnchorRuns += 1; continue }
    const anchors = Array.isArray(d.anchors) ? d.anchors : []
    const missed = Array.isArray(d.missed) ? d.missed : []
    const total = Number.isInteger(d.total) ? d.total : anchors.length
    const hits = Number.isInteger(d.hits) ? d.hits : Math.max(0, anchors.length - missed.length)
    if (Number.isInteger(d.factsCount) && d.factsCount > 0) {
      facts += d.factsCount
      verifiableFacts += Number.isInteger(d.verifiableFacts) ? d.verifiableFacts : total
    }
    if (total <= 0) { noAnchorRuns += 1; continue }
    if (hits <= 0) zeroRuns += 1
    const key = hits + '/' + total
    const cur = byKey.get(key) ?? { key, hits, total, n: 0 }
    cur.n += 1
    byKey.set(key, cur)
  }
  const buckets = [...byKey.values()].sort((a, b) => (b.hits / b.total - a.hits / a.total) || (b.total - a.total) || a.key.localeCompare(b.key))
  return {
    runs: list.length,
    buckets,
    zeroRuns,
    noAnchorRuns,
    facts,
    verifiableFacts,
    verifiableRatio: facts > 0 ? verifiableFacts / facts : null,
  }
}

export default { extractAnchors, verifyAnchors, pinAnchorReport, summarizePinHistory }
