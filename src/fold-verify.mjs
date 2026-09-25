// src/fold-verify.mjs — 折叠后「不可丢约束」校验（确定性、零 LLM、零新存储）。
//
// 动因（2026-09-25）：论文实证显示压缩的失败点不在摘要质量，而在**约束与结构的丢失**
// （arXiv 2608.11242 / 2605.08580 / 2608.16370），且「载入」不等于「约束生效」
// （arXiv 2607.17937：同模型同任务，干净上下文 10 过 8，污染上下文 10 过 3）。
// 也就是说：折叠前把 PIN 注进去只是**请求**，折叠后必须**校验**它还在不在。
//
// 与 anchor.mjs（C6 v1）的关系：anchor.mjs 负责「抽字面锚点 + 包含比对」这一层原语；
// 本模块负责 C6 v1 缺的那两半——
//   ① 折叠前的**清单摘要**：PIN 集合 + 每条约束的稳定标识（sha256，非 LLM），
//      且区分「已注入」与「被 PIN 预算截断、从未发给模型」；
//   ② 折叠后的**三态结论** ok / partial / lost 落审计，默认只告警不阻塞。
//
// 为什么要区分「未注入」与「丢失」（真实误判，2026-09-25 修）：
// PIN 有 1800 字符预算（pinner.PIN_BUDGET_CHARS），超预算的整条丢弃。旧口径把这些
// 从未注入的事实也拿去抽锚点、算进 missed，于是**我们自己的截断被记成了模型犯错**——
// 命中率被系统性低估，排查方向从一开始就是错的。现在两者分列：
//   notInjectedFacts = 我们自己没发出去（路径问题：改预算/改优先级）
//   missed/lostIds    = 发出去了但摘要没带（模型问题：改摘要指令）
//
// 边界（诚实声明，对应仓库铁律 2「未接线不宣称」）：
// 本模块**只看摘要正文**，不读折叠后 session surface。原因不是省事，是观测点不成立——
// 官方 compaction-basic 的 commitCompactionBody 先 append `compaction/summary`、**其后**
// 才 append 带 surfaceOp:replace 的 checkpoint 消息（lib/index.js:589 与 :605），
// 而 maid 的 summarize 钩子在两者之前被调用。此时读 session.surface 拿到的是**折叠前**
// 的节点，任何「约束仍在上下文里」的判定都会假绿。故不接线，见 README 诚实声明表。

import { createHash } from 'node:crypto'
import { extractAnchors, verifyAnchors } from './anchor.mjs'

/** 结论状态全集（审计 detail.status 的取值域）。 */
export const FOLD_VERIFY_STATUSES = ['ok', 'partial', 'lost', 'unverifiable', 'not-injected', 'no-summary', 'idle']

const ID_LEN = 10
const DEFAULT_MAX_ANCHORS = 5
const DEFAULT_MAX_MANIFEST_IDS = 12
const NUL = String.fromCharCode(0)

/** 归一化：去所有空白 + 小写（与 anchor.normalize 同口径：摘要模型会改写换行与大小写）。 */
function normalize(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase()
}

/**
 * 从 PIN 事实的固定前缀判定约束来源类型。确定性，不调模型。
 * 前缀由 pinner.collectPinnedFacts 生成：'[ACP <authority>]' / '[goal]' / '[user-pinned]'。
 * @param {string} text
 * @returns {string} 'acp:<authority>' | 'goal' | 'user-pinned' | 'other'
 */
export function constraintKind(text) {
  const raw = String(text ?? '')
  const acp = /^\[ACP\s+([A-Za-z_]+)\]/.exec(raw)
  if (acp) return 'acp:' + acp[1].toLowerCase()
  if (/^\[goal\]/i.test(raw)) return 'goal'
  if (/^\[user-pinned\]/i.test(raw)) return 'user-pinned'
  return 'other'
}

/**
 * 约束的稳定标识：sha256(kind + NUL + 归一化全文) 前 10 位十六进制。
 * 同一约束在任何一次折叠里都得到同一个 id，因此审计行之间可比对（这是「清单摘要」的支点）。
 * @param {string} kind - constraintKind 的输出
 * @param {string} text
 * @returns {string}
 */
export function constraintId(kind, text) {
  const k = String(kind ?? 'other')
  return createHash('sha256').update(k + NUL + normalize(text), 'utf8').digest('hex').slice(0, ID_LEN)
}

/**
 * 折叠前的「不可丢约束清单」摘要。
 *
 * injected 的语义必须与 pinner.planPinInstruction 的 kept 一致——它保留的是事实列表的
 * **前缀**（按 authority 优先级排过序），所以这里同样取前缀，不重排序。
 * @param {string[]} facts - collectPinnedFacts 的原始事实（非渲染块）
 * @param {{injected?: number, budget?: number, maxAnchors?: number, maxIds?: number}} [opts]
 * @returns {object} 清单摘要（见下）
 */
export function buildConstraintManifest(facts, opts = {}) {
  const list = Array.isArray(facts) ? facts : []
  const total = list.length
  const injected = Number.isInteger(opts.injected)
    ? Math.max(0, Math.min(total, opts.injected))
    : total
  const maxIds = Number.isInteger(opts.maxIds) ? opts.maxIds : DEFAULT_MAX_MANIFEST_IDS
  const injectedList = list.slice(0, injected)
  const ids = []
  const anchors = []
  const anchorOwners = {}
  let verifiableFacts = 0
  for (const f of injectedList) {
    const kind = constraintKind(f)
    const id = constraintId(kind, f)
    ids.push({ id, kind })
    const a = extractAnchors(f, opts)
    if (a.length > 0) verifiableFacts += 1
    for (const x of a) {
      if (anchorOwners[x] !== undefined) continue
      anchorOwners[x] = id
      anchors.push(x)
    }
  }
  const capped = anchors.slice(0, Number.isInteger(opts.maxAnchors) ? opts.maxAnchors : DEFAULT_MAX_ANCHORS)
  const owners = {}
  for (const a of capped) owners[a] = anchorOwners[a]
  return {
    v: 1,
    total,
    injected,
    omitted: total - injected,
    budget: Number.isFinite(opts.budget) ? Number(opts.budget) : null,
    ids: ids.slice(0, maxIds),
    idCount: ids.length,
    anchors: capped,
    anchorOwners: owners,
    verifiableFacts,
    unverifiableFacts: injected - verifiableFacts,
  }
}

/**
 * 折叠后校验：清单里的约束是否仍可用（字面锚点仍在摘要正文中）。
 *
 * 状态语义（互斥，且刻意把「没得验」「没发出去」从「丢了」里摘出来）：
 *   idle         无约束可校验（清单为空）——不制造噪声
 *   not-injected 一条都没注入（未启用 PIN / 预算全截断 / 收集路径断开）
 *   no-summary   摘要正文为空，无从校验（不冒充 lost，避免假警报）
 *   unverifiable 注入了但一条字面锚点都抽不出——「没得验」≠「验过了没丢」
 *   ok           全部可校验锚点都在（V/V）
 *   partial      部分丢失（0 < hits < checked），lostIds 列出具体丢了哪些约束
 *   lost         完全丢失（hits === 0 且 checked > 0）
 * @param {object} manifest - buildConstraintManifest 的输出
 * @param {string} summaryText - 折叠后的 checkpoint 摘要正文
 * @returns {object}
 */
export function verifyFoldConstraints(manifest, summaryText) {
  const m = manifest && typeof manifest === 'object' ? manifest : null
  const base = {
    status: 'idle',
    total: m?.total ?? 0,
    injected: m?.injected ?? 0,
    omitted: m?.omitted ?? 0,
    checked: 0,
    hits: 0,
    missed: [],
    lostIds: [],
    ratio: null,
  }
  if (!m || base.total === 0) return base
  if ((m.injected ?? 0) === 0) return { ...base, status: 'not-injected' }
  const anchors = Array.isArray(m.anchors) ? m.anchors : []
  if (anchors.length === 0) return { ...base, status: 'unverifiable' }
  if (!String(summaryText ?? '').trim()) return { ...base, status: 'no-summary' }
  const v = verifyAnchors(anchors, summaryText)
  const owners = m.anchorOwners && typeof m.anchorOwners === 'object' ? m.anchorOwners : {}
  const lostIds = []
  for (const a of v.missed) {
    const id = owners[a]
    if (id && !lostIds.includes(id)) lostIds.push(id)
  }
  // verifyAnchors 的 hits/missed 是**数组**；这里换成计数口径（否则 status 恒为 partial）。
  const hits = Array.isArray(v.hits) ? v.hits.length : Number(v.hits ?? 0)
  const status = hits === 0 ? 'lost' : (hits >= v.total ? 'ok' : 'partial')
  return {
    status,
    total: base.total,
    injected: base.injected,
    omitted: base.omitted,
    checked: v.total,
    hits,
    missed: v.missed,
    lostIds,
    ratio: v.ratio,
  }
}

/**
 * 近 N 次折叠校验的状态分布（/context-maid status 用）。
 * 与 summarizePinHistory 的分工：那个报「命中率分布」，这个报「三态结论分布」。
 * 没有 status 字段的行（C6 v1 时期）单独计入 unstated——不能默认成 ok，
 * 否则历史空洞会被读成「一直很好」。
 * @param {Array<{op?: string, detail?: string}>} rows - audit.recent() 的结果（含非 pin 行，内部过滤）
 * @param {{maxRuns?: number}} [opts]
 * @returns {object}
 */
export function summarizeFoldVerify(rows, opts = {}) {
  const maxRuns = Number.isInteger(opts.maxRuns) ? opts.maxRuns : 20
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.op === 'pin').slice(0, maxRuns)
  const out = { runs: 0, ok: 0, partial: 0, lost: 0, unverifiable: 0, notInjected: 0, noSummary: 0, unstated: 0, lostIds: [] }
  for (const r of list) {
    let d = null
    try { d = JSON.parse(String(r.detail ?? '')) } catch { d = null }
    const status = d && typeof d === 'object' ? d.status : undefined
    if (typeof status !== 'string' || !status) { out.unstated += 1; continue }
    out.runs += 1
    if (status === 'ok') out.ok += 1
    else if (status === 'partial') out.partial += 1
    else if (status === 'lost') out.lost += 1
    else if (status === 'unverifiable') out.unverifiable += 1
    else if (status === 'not-injected') out.notInjected += 1
    else if (status === 'no-summary') out.noSummary += 1
    if (Array.isArray(d.lostIds)) {
      for (const id of d.lostIds) if (typeof id === 'string' && id && !out.lostIds.includes(id)) out.lostIds.push(id)
    }
  }
  return out
}

export default { FOLD_VERIFY_STATUSES, constraintKind, constraintId, buildConstraintManifest, verifyFoldConstraints, summarizeFoldVerify }
