// src/pinner.mjs — 钉扎段：收集「必须保留」事实，注入摘要指令（软保护，M3）。
//
// spike 结论（2026-09-03）：官方压缩从头部压连续段，中段 PIN 无法硬性排除
// （会破坏连续范围与事务语义）。M3 v1 采用软保护：
//   - summarize 前把 PIN 事实作为一条 plugin user message 注入被压区域重放，
//     摘要模型看到「必须保留事实」清单 → checkpoint 覆盖其语义
//   - PIN 来源：ACP 高 authority observation（可选服务）/ work_state goal（可选）/
//     用户显式 pin.extra 清单
// 硬保护（压缩范围排除 PIN 段）留作已知限制与未来工作。

/** 收集 PIN 事实文本（确定性；服务缺失自动跳过，不制造硬依赖）。 */
export async function collectPinnedFacts(ctx, opts = {}) {
  const facts = []
  const seen = new Set()

  const push = (text) => {
    const t = String(text ?? '').trim()
    if (t && !seen.has(t)) { seen.add(t); facts.push(t) }
  }

  // 1) ACP 高 authority observation（user_explicit / user_correction / system_policy）
  try {
    const acp = typeof ctx?.get === 'function' ? ctx.get('acp') : undefined
    if (acp && typeof acp.query === 'function') {
      const hits = await acp.query({ scopeId: opts.scopeId ?? 'user-global', limit: 15 })
      for (const h of Array.isArray(hits?.items) ? hits.items : (Array.isArray(hits) ? hits : [])) {
        const authority = h?.authority ?? ''
        if (authority === 'user_explicit' || authority === 'user_correction' || authority === 'system_policy') {
          const content = String(h?.content ?? h?.text ?? '').trim()
          if (content && content.length <= 500) push('[ACP ' + authority + '] ' + content)
        }
      }
    }
  } catch { /* ACP 不可用/出错 → 跳过 */ }

  // 2) work-continuity 当前 goal（可选服务 ctx.work）
  try {
    const work = typeof ctx?.get === 'function' ? ctx.get('work') : undefined
    const cwd = opts.cwd ?? ''
    if (work && typeof work.get === 'function' && cwd) {
      const st = work.get(cwd) // work.get(scopeId, projectId?) 位置参数
      if (st && typeof st.goal === 'string' && st.goal.trim()) push('[goal] ' + st.goal.trim())
    }
  } catch { /* work 不可用 → 跳过 */ }

  // 3) 用户显式钉扎清单
  const extra = Array.isArray(opts.extra) ? opts.extra : []
  for (const e of extra) push('[user-pinned] ' + e)

  return facts
}

/** 渲染成给摘要模型的 PIN 指令段（插在被压区域与官方压缩指令之间）。 */
export function buildPinInstruction(facts) {
  if (!facts || facts.length === 0) return ''
  const list = facts.map((f) => '- ' + f).join('\n')
  return '\n[context-maid pin] The following facts are pinned by the user or carry high authority. '
    + 'They MUST be reflected in the checkpoint summary (preserve their meaning and key details):\n'
    + list
}

export default { collectPinnedFacts, buildPinInstruction }
