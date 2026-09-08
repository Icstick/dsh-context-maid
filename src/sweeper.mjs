// src/sweeper.mjs — 无效日志/僵尸清理（M2 主战场②；M6 执行器落地）
//
// 2026-09-08 取证修正（0.3.0 设计稿 §2.2/§4）：旧扫描基于 'tool/call' 事件——
// 官方真实事件模型里 tool-call 嵌在 assistant/message 的 content blocks
// （block.type === 'tool-call'），tool/result 事件经 message.source.callId 配对。
// 输入改为 surface 投影视角（session.surface.nodes + eventAt），与官方
// ToolResultPruner 一致；shadowed 旧节点对模型不可见、无需清。
//
// 处置（D1-A 拍板）：sweeper 只产「节点级建议」，执行 = model-free stub
// （slimmer.mjs 导出 stubToolResultNode，compaction/prune + replace 协议）。
// 保守原则：拿不准就 SLIM 而非 SWEEP；aggressive 档规则暂未扩展（README 标注）。

/** 结果文本是否已是 maid 处置标记（stub/slim 副本——不再参与指纹与规则） */
function isMaidMarked(text) {
  const s = String(text ?? '')
  return s.startsWith('[maid sweep') || s.includes('… [maid slim')
}

/**
 * 从 assistant tool-call 描述提取指纹（确定性）。
 * 兼容输入：{ name, args? } 或 tool-call block { name, arguments? }
 * 或旧形状事件 { data: { name, args } }（CM3 语义锚点：路径/URL 类参数入指纹）。
 * 参数指纹：文件/路径/url 类键取原值（<200 字符），其余只取键集合（避免大参数入指纹）。
 * @param {object|null|undefined} call
 * @returns {string} 指纹或 ''
 */
export function toolFingerprint(call) {
  if (!call || typeof call !== 'object') return ''
  const src = call.data && typeof call.data === 'object' ? call.data : call
  const name = src.name ?? src.toolName ?? ''
  if (!name) return ''
  let args = src.args ?? src.arguments ?? {}
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = {} }
  }
  if (!args || typeof args !== 'object') args = {}
  let sig = String(name)
  const pathKeys = ['file_path', 'path', 'url', 'repo', 'file', 'query']
  for (const k of pathKeys) {
    const v = typeof args[k] === 'string' ? args[k] : undefined
    if (typeof v === 'string' && v.length < 200) sig += '|' + k + '=' + v
  }
  return sig
}

/** 提取 tool result 文本（与旧版同语义） */
export function extractResultText(event) {
  try {
    const msg = event?.data?.message
    const content = Array.isArray(msg?.content) ? msg.content : []
    const parts = []
    for (const b of content) {
      if (b?.type === 'text') parts.push(b.text)
      else if (b?.type === 'tool-result-text' && typeof b.text === 'string') parts.push(b.text)
      else if (b?.type === 'tool-result' && Array.isArray(b.content)) {
        for (const cb of b.content) {
          if (cb?.type === 'text') parts.push(cb.text)
          else if (cb?.type === 'tool-result-text' && typeof cb.text === 'string') parts.push(cb.text)
        }
      }
    }
    return parts.join('\n').trim()
  } catch { return '' }
}

/** 结果是否失败（确定性；CM1 语义锚点） */
export function isFailureResult(event) {
  const text = extractResultText(event)
  if (!text) return false
  const head = text.slice(0, 600)
  return /error|failed|exception|traceback|errno|exit code [1-9]|denied|refused|not found|ETIMEDOUT|ENOENT/i.test(head)
}

/**
 * 扫描 session 表面，产出建议清理节点（M6：真实事件模型 + surface 视角）。
 * 全量扫描（每调用 O(surface)）；处置后原 seq 离开 surface，天然防重复建议。
 * @param {object} session - dsh Session（surface.nodes / eventAt）
 * @returns {{seq: number, kind: string, reason: string}[]} 按 seq 升序
 */
export function scanSweepCandidates(session) {
  const candidates = []
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return candidates
  const pendingCalls = new Map() // callId → { fp, assistantSeq }
  const lastSuccess = new Map() // fp → seq（最近成功 result）
  const failures = new Map() // fp → seq[]（未获后续成功的失败 result）

  const surfaceSet = new Set(nodes)

  const suggest = (seq, kind, reason) => {
    if (!surfaceSet.has(seq)) return
    if (candidates.some((c) => c.seq === seq)) return
    candidates.push({ seq, kind, reason })
  }

  for (const seq of nodes) {
    const ev = session.eventAt(seq)
    if (!ev || typeof ev !== 'object') continue
    const type = ev.type ?? ''
    if (type === 'assistant/message') {
      const blocks = ev.data?.message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (!block || block.type !== 'tool-call') continue
        const callId = block.id ?? block.callId ?? ''
        if (!callId) continue
        const fp = toolFingerprint(block)
        pendingCalls.set(callId, { fp, assistantSeq: seq })
      }
    } else if (type === 'tool/result') {
      const text = extractResultText(ev)
      if (isMaidMarked(text)) continue // 已是 maid 处置副本
      const callId = ev.data?.message?.source?.callId ?? ''
      const call = callId ? pendingCalls.get(callId) : undefined
      if (call) pendingCalls.delete(callId)
      const fp = call?.fp ?? ''
      if (!fp) continue // 无配对 call 或无名——保守跳过
      const ok = !isFailureResult(ev)
      if (ok) {
        // failed-retry：此前同 fp 失败且未获成功 → 清
        const prior = failures.get(fp)
        if (Array.isArray(prior)) {
          for (const fseq of prior) {
            suggest(fseq, 'failed-retry', '失败结果已被后续同目标成功取代')
          }
          failures.delete(fp)
        }
        // superseded-read：同 fp 已有成功 → 前序成功可清
        const prev = lastSuccess.get(fp)
        if (prev !== undefined && prev !== seq) {
          const prevEv = session.eventAt(prev)
          if (prevEv?.type === 'tool/result' && !isMaidMarked(extractResultText(prevEv))) {
            suggest(prev, 'superseded-read', '同工具同参数前序结果已被后序取代')
          }
        }
        lastSuccess.set(fp, seq)
      } else {
        // 失败：记录待后续成功配对（同一 fp）
        const prior = failures.get(fp) ?? []
        if (!prior.includes(seq)) prior.push(seq)
        failures.set(fp, prior)
      }
    }
  }
  return candidates.sort((a, b) => a.seq - b.seq)
}

export default { scanSweepCandidates, toolFingerprint, isFailureResult, extractResultText }
