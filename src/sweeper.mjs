// src/sweeper.mjs — 无效日志/僵尸清理（M2 主战场②）。
//
// 识别（确定性，不调 LLM）：
//  - 孤儿 tool-call（无配对 result）——由表面结构判定
//  - 同工具重复读取：同 toolName + 相似参数指纹的前序结果被后序取代
//  - 失败中间产物：失败结果后同目标成功 → 失败段可清理
//  - 被 compaction replace 遮蔽的段（shadowedSeqs）——官方已处理，这里不重复
//
// 执行：返回「建议清理的区间」，由调用方走官方 compactRegion 事务落地
// （sweeper 自身不做 surface 变更——保持可测试纯函数 + 执行分离）。
//
// 保守原则：拿不准就 SLIM 而非 SWEEP；aggressive 档才放宽规则。

/**
 * 从会话事件流提取 tool 调用指纹（确定性）。
 * @param {object} event - session event
 * @returns {string} 指纹或 ''
 */
export function toolFingerprint(event) {
  if (!event || typeof event !== 'object') return ''
  const name = event.data?.name ?? event.data?.toolName ?? event.data?.call?.name ?? ''
  if (!name) return ''
  const args = event.data?.args ?? event.data?.arguments ?? event.data?.call?.args ?? {}
  // 参数指纹：文件/路径/url 类键取原值，其余只取键集合（避免大参数入指纹）
  let sig = name
  if (args && typeof args === 'object') {
    const pathKeys = ['file_path', 'path', 'url', 'repo', 'file', 'query']
    for (const k of pathKeys) {
      if (typeof args[k] === 'string' && args[k].length < 200) sig += '|' + k + '=' + args[k]
    }
  }
  return sig
}

/**
 * 扫描会话事件，产出建议清理区间。
 * @param {object[]} events - session.events（含 type/seq/data）
 * @param {object} opts - { aggressive?: boolean }
 * @returns {object[]} [{ startSeq, endSeq, reason, kind }] startSeq/endSeq 为事件 seq
 */
export function scanSweepCandidates(events, opts = {}) {
  const aggressive = opts.aggressive === true
  const candidates = []
  const byTool = new Map() // fingerprint → last seq
  const toolCalls = new Map() // seq → fingerprint
  const toolResults = new Map() // seq → { fingerprint, ok }

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const type = ev.type ?? ''
    const seq = ev.seq ?? ev.id
    if (type === 'tool/call') {
      const fp = toolFingerprint(ev)
      toolCalls.set(seq, fp)
    } else if (type === 'tool/result') {
      const fp = toolFingerprint(ev)
      const ok = !isFailureResult(ev)
      toolResults.set(seq, { fp, ok })
      if (fp) byTool.set(fp, seq)
    }
  }

  // 1) 孤儿 tool-call（有 call 无 result）：找 tool/call 后没有配对的
  //    简化：表面连续的 call→result 对在官方 surface 已配对；孤儿指 result 缺失——
  //    这里只标记「无任何 result 的 call」风险，保守默认不清理（可能正在执行），
  //    仅在 aggressive 档返回。
  if (aggressive) {
    for (const [seq, fp] of toolCalls) {
      let paired = false
      for (const [, r] of toolResults) if (r.fp === fp) { paired = true; break }
      if (!paired) candidates.push({ startSeq: seq, endSeq: seq, kind: 'orphan-call', reason: '孤儿 tool-call（无配对 result）' })
    }
  }

  // 2) 被取代的重复读取：同指纹多次 result，前序非失败 → 建议清前序（保留最后一次）
  const seen = new Map() // fp → last seq (keep)
  for (const [seq, { fp, ok }] of toolResults) {
    if (!fp) continue
    if (seen.has(fp) && ok) {
      const prev = seen.get(fp)
      candidates.push({ startSeq: prev, endSeq: prev, kind: 'superseded-read', reason: '同工具同参数前序结果已被后序取代' })
    }
    if (ok) seen.set(fp, seq)
  }

  // 3) 失败中间产物：同一指纹 失败→成功 序列中，失败结果可清（保留 call 上下文）
  const failures = []
  for (const [seq, { fp, ok }] of toolResults) {
    if (!ok) failures.push({ seq, fp })
  }
  for (const f of failures) {
    const later = [...toolResults.entries()].find(([s, r]) => s > f.seq && r.fp === f.fp && r.ok)
    if (later) {
      candidates.push({ startSeq: f.seq, endSeq: f.seq, kind: 'failed-retry', reason: '失败结果已被后续同目标成功取代' })
    }
  }

  // 4) stderr 噪音（超长且无错误关键字的 tool result 文本）—— 归 SLIM 而非 SWEEP，
  //    这里不做。SWEEP 只处理结构性无效。

  return candidates
}

/** 结果是否失败（确定性） */
export function isFailureResult(event) {
  const text = extractResultText(event)
  if (!text) return false
  const head = text.slice(0, 600)
  return /error|failed|exception|traceback|errno|exit code [1-9]|denied|refused|not found|ETIMEDOUT|ENOENT/i.test(head)
}

/** 提取 tool result 文本 */
export function extractResultText(event) {
  try {
    const msg = event?.data?.message
    const content = Array.isArray(msg?.content) ? msg.content : []
    const parts = []
    for (const b of content) {
      if (b?.type === 'text') parts.push(b.text)
      else if (b?.type === 'tool-result-text' && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.join('\n').trim()
  } catch { return '' }
}

export default { scanSweepCandidates, toolFingerprint, isFailureResult }
