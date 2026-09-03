// src/archiver.mjs — 先归档后压缩：消费 compaction/summary 事件，把摘要写入 ACP ledger。
//
// 设计（docs/dsh-context-maid-design.md §5.5）：
//  - 摘要即证据：每次 FOLD 的 checkpoint 摘要成为 ledger 一条 observation
//    （subject=session 标识，text=摘要，evidenceIds=被压段证据 id，supersedes 链关联）
//  - 与引擎解耦：监听 session/event 的 compaction/summary（旁路模式同样工作）
//  - ACP 为可选服务：不在线自动跳过（maid 不制造硬依赖）
//
// 2026-09-03 实测修复（live 验证：/compact 成功但 maid_audit 0 行）：
//  - audit-first：事件到达即无条件写 audit（detail 记录归档结果/跳过原因），
//    审计不再依赖 ACP 在线——可区分「事件未达」与「归档路径断开」。
//  - acp 解析多路：ctx.get('acp') → ctx.acp（cordis provide 属性访问）兜底。
// 2026-09-03 二次实测（audit 落行但 archive_ids 空，detail=「acp.append 未返回 id」）：
//  - 根因：ACP writeGuard secret 扫描 block——摘要正文含「token: 5a8cda…」等
//    疑似凭据格式（checkpoint 摘要保留命令/配置值，易命中）。ACP 安全功能正确，
//    归档侧适配：预脱敏（REDACT_PATTERNS 与 ACP governance.mjs SECRET_PATTERNS 同步），
//    block 后自动脱敏重试一次；detail 记录 append 的 decision/reasons（可观测）。
//
// 注意：原始被压内容已在 ACP ledger（ACP 并行摄入全部会话事件）——
// 这里补的是「摘要级」沉淀，让被压区间的语义可经 ACP recall 一层找回。

/**
 * 从 compaction/summary 事件提取摘要文本。
 * @param {object} event - session/event 的 compaction/summary
 * @returns {string} 摘要文本（内容块拼接）
 */
export function summaryTextOf(event) {
  try {
    const summary = event?.data?.summary
    if (typeof summary === 'string') {
      try {
        const parsed = JSON.parse(summary)
        if (Array.isArray(parsed)) {
          return parsed.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        }
        return summary
      } catch { return summary }
    }
    if (Array.isArray(summary)) {
      return summary.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    }
    return ''
  } catch { return '' }
}

/**
 * 摘要预脱敏（归档内容消毒）。
 * 与 ACP governance.mjs SECRET_PATTERNS 同步维护（2026-09-03）：
 * ACP writeGuard 对疑似凭据 block——压缩摘要保留命令/配置值易命中（如
 * 「frp token: 5a8cda…」），整条被拒会丢失归档。这里把值打码后再 append。
 * 注意：若 ACP 侧 pattern 更新，此处需跟随（双保险：block 后还会重试一次）。
 * @param {string} text
 * @returns {string} 脱敏后文本
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text
  let out = text
  // 键值对：保留 key 名，打码值（≥12 字符疑似凭据）
  out = out.replace(/\b((?:sk|pk|api[_-]?key|token|secret|password|passwd|pwd|credential|bearer|private[_-]?key|access[_-]?key)\b\s*[:=]\s*['"]?)[A-Za-z0-9_\-]{12,}/gi, '$1[redacted]')
  // 高熵 token 形态整体打码
  out = out.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[redacted]')          // GitHub PAT
  out = out.replace(/\bgho_\w{20,}\b/g, '[redacted]')
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, '[redacted]')   // Slack token
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')               // AWS access key
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]') // JWT
  out = out.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted]')
  return out
}

/**
 * 尝试把摘要写入 ACP；block（疑似凭据）时脱敏重试一次。
 * @param {object} acp - ACP service
 * @param {string} content - 待归档 content（已截断到预算内）
 * @param {object} sourceRef - { sessionEventId, maidCompactionId }
 * @param {string} seq - 事件 seq
 * @returns {{archiveIds: string[], note: string}}
 */
function appendArchive(acp, content, sourceRef) {
  const base = {
    sourceClass: 'agent_authored',
    authority: 'single_observation',
    confidence: 0.6,
    durability: 0.5,
    sensitivity: 'internal',
    claimDomain: 'experience',
    sourceRef,
  }
  const attempt = (body) => acp.append({ ...base, content: body })
  let result = attempt(content)
  const verdictNote = (r) => {
    const parts = []
    if (r && r.decision) parts.push('decision=' + r.decision)
    if (r && Array.isArray(r.reasons) && r.reasons.length) parts.push('reasons=[' + r.reasons.join('; ') + ']')
    return parts.length ? '（' + parts.join(' ') + '）' : ''
  }
  if (result && result.id) {
    return { archiveIds: [result.id], note: '已归档 ' + result.id + verdictNote(result) }
  }
  // block / 异常返回 → 脱敏重试一次
  if (!(result && result.id)) {
    const sanitized = redactSecrets(content)
    if (sanitized !== content) {
      result = attempt(sanitized)
      if (result && result.id) {
        return { archiveIds: [result.id], note: '已归档 ' + result.id + '（内容含疑似凭据，已脱敏重试）' }
      }
    }
  }
  return {
    archiveIds: [],
    note: 'acp.append 未返回 id' + verdictNote(result)
      + (result && result.decision === 'block' ? '（block 含疑似凭据且脱敏后仍被拒）' : ''),
  }
}

/**
 * 解析 ACP service：多路兜底（ctx.get → ctx.acp）。
 * cordis 下 ctx.provide('acp', …) 注册的 service 可经 ctx.get('acp') 获取；
 * 部分宿主/上下文层级下 ctx.get 解析不到时，属性访问 ctx.acp 仍可命中。
 * @param {object} ctx
 * @returns {object|undefined} acp service（含 append 方法）或 undefined
 */
export function getAcpService(ctx) {
  if (!ctx) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('acp') : undefined
    if (viaGet && typeof viaGet.append === 'function') return viaGet
  } catch { /* 继续下一路 */ }
  try {
    if (ctx.acp && typeof ctx.acp.append === 'function') return ctx.acp
  } catch { /* 继续 */ }
  return undefined
}

/**
 * 注册 archiver：session/event 上消费 compaction/summary → ACP ledger + 审计。
 * audit-first：事件到达即写审计（无论 ACP 是否在线/摘要是否为空），
 * detail 字段记录归档结果或跳过原因——保证策展可观测。
 * fail-open：任何异常只 warn，不阻断事件派发。
 * @param {object} ctx - cordis Context
 * @param {object} opts - { enabled, audit }
 */
export function registerArchiver(ctx, opts = {}) {
  const enabled = opts.enabled !== false
  ctx.on('session/event', (session, event) => {
    try {
      if (!enabled) return
      if (!event || event.type !== 'compaction/summary') return
      const data = event.data ?? {}
      const text = summaryTextOf(event)
      const acp = getAcpService(ctx)

      let archiveIds = []
      let note = ''
      if (!acp) {
        note = 'acp 不可用（ctx.get/ctx.acp 均未解析到 append）→ 跳过归档'
      } else if (!text) {
        note = 'summary 文本为空 → 跳过归档'
      } else {
        try {
          const summary = text.slice(0, 1800) // observation text 预算（ACP 上限 8000）
          const out = appendArchive(acp, '【maid 压缩归档】' + summary, {
            sessionEventId: String(event.seq ?? ''),
            maidCompactionId: String(data.compactionId ?? ''),
          })
          archiveIds = out.archiveIds
          note = out.note
        } catch (err) {
          note = 'acp.append 失败: ' + (err instanceof Error ? err.message : String(err))
        }
      }
      // audit-first：无条件留痕（审计失败不阻断策展）
      try {
        opts.audit?.append?.({
          op: 'fold',
          sessionId: session?.id ?? '',
          range: data.shadowedRange ? data.shadowedRange.start + ':' + data.shadowedRange.end : '',
          tokensBefore: data.shadowedTokenCount,
          archiveIds,
          summary: 'compaction/summary → ' + (archiveIds.length > 0 ? 'ACP ' + archiveIds[0] : note),
          detail: note,
        })
      } catch { /* 审计失败不阻断 */ }
    } catch (err) {
      ctx.logger?.warn?.('[context-maid] archive_failed reason='
        + (err instanceof Error ? err.message : String(err)))
    }
  })
}

export default registerArchiver
