import { createHash } from 'node:crypto'

// src/pinner.mjs — 钉扎段：收集「必须保留」事实，注入摘要指令（软保护，M3）。
//
// spike 结论（2026-09-03）：官方压缩从头部压连续段，中段 PIN 无法硬性排除
// （会破坏连续范围与事务语义）。M3 v1 采用软保护：
//   - summarize 前把 PIN 事实作为一条 plugin user message 注入被压区域重放，
//     摘要模型看到「必须保留事实」清单 → checkpoint 覆盖其语义
//   - PIN 来源：ACP 高 authority observation（可选服务）/ work_state goal（可选）/
//     用户显式 pin.extra 清单
// 硬保护（压缩范围排除 PIN 段）留作已知限制与未来工作。


/** WC scopeIdForCwd 同语义派生（2026-09-07 P0-1：对齐 sha256(cwd 小写) 前 12 位，勿 import WC 内部） */
export function scopeIdForCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'user-global'
  return 'ws:' + createHash('sha256').update(cwd.toLowerCase(), 'utf8').digest('hex').slice(0, 12)
}

/** PIN 权威白名单（2026-09-07 P0-1：本地二次防御，服务端 authorities 过滤之外的兜底） */
const PIN_AUTHORITIES = new Set(['user_explicit', 'user_correction', 'system_policy'])

/** 收集 PIN 事实文本（确定性；服务缺失自动跳过，不制造硬依赖）。 */
export async function collectPinnedFacts(ctx, opts = {}) {
  const facts = []
  const seen = new Set()

  const push = (text) => {
    const t = String(text ?? '').trim()
    if (t && !seen.has(t)) { seen.add(t); facts.push(t) }
  }

  // 1) ACP 高 authority observation（user_explicit / user_correction / system_policy）
  // P0-1 修复（2026-09-07 审计）：旧实现调 acp.query——ACP 0.2.0 无此方法，typeof 守卫静默跳过，
  // PIN 高权威源从未生效（golden CM5 用 mock acp.query 掩盖）。正解 = acp.queryObservations
  // （service 面同日补齐，store.queryObservation 支持 authorities IN 过滤）。
  try {
    const acp = typeof ctx?.get === 'function' ? ctx.get('acp') : undefined
    if (acp && typeof acp.queryObservations === 'function') {
      const hits = await acp.queryObservations({
        scopeId: opts.scopeId ?? 'user-global',
        state: 'active',
        authorities: ['user_explicit', 'user_correction', 'system_policy'],
        limit: 15,
      })
      for (const h of Array.isArray(hits?.items) ? hits.items : []) {
        const authority = h?.authority ?? ''
        if (!PIN_AUTHORITIES.has(authority)) continue
        const content = String(h?.text ?? '').trim()
        if (content && content.length <= 500) push('[ACP ' + authority + '] ' + content)
      }
    }
  } catch { /* ACP 不可用/出错 → 跳过 */ }

  // 2) work-continuity 当前 goal（可选服务 ctx.work）
  try {
    const work = typeof ctx?.get === 'function' ? ctx.get('work') : undefined
    const cwd = opts.cwd ?? ''
    if (work && typeof work.get === 'function' && cwd) {
      // P0-1（2026-09-07）：旧实现把原始 cwd 当 scopeId 传——WC 行存于 ws:+sha256(cwd) 前 12 位永不命中
      const sid = scopeIdForCwd(cwd)
      const st = work.get(sid) // work.get(scopeId, projectId?)
      if (st && typeof st.goal === 'string' && st.goal.trim()) push('[goal] ' + st.goal.trim())
    }
  } catch { /* work 不可用 → 跳过 */ }

  // 3) 用户显式钉扎清单
  const extra = Array.isArray(opts.extra) ? opts.extra : []
  for (const e of extra) push('[user-pinned] ' + e)

  return facts
}

/** PIN 指令预算（B10，2026-09-08 拍板：≤600 token ≈ 1800 字符 @3 chars/token）。
 *  超出按收集顺序截断（收集顺序已按 authority 优先级稳定排序：
 *  user_explicit/correction > system_policy > goal > extra），整条丢弃保语义完整，
 *  追加 [+N more] 计数标注。 */
export const PIN_BUDGET_CHARS = 1800

/** 渲染成给摘要模型的 PIN 指令段（插在被压区域与官方压缩指令之间）。 */
export function buildPinInstruction(facts, budget = PIN_BUDGET_CHARS) {
  if (!facts || facts.length === 0) return ''
  const kept = []
  let total = 0
  for (const f of facts) {
    const item = '- ' + f
    if (total + item.length > budget) break
    kept.push(item)
    total += item.length
  }
  const omitted = facts.length - kept.length
  const list = omitted > 0 ? kept.concat(['- [+' + omitted + ' more facts omitted — PIN 预算 ' + budget + ' chars]']) : kept
  return '\n[context-maid pin] The following facts are pinned by the user or carry high authority. '
    + 'They MUST be reflected in the checkpoint summary (preserve their meaning and key details):\n'
    + list.join('\n')
}

export default { collectPinnedFacts, buildPinInstruction }
