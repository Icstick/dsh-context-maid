// src/commands.mjs — /context-maid 命令族：status / config / help
//
// M1：status（引擎提供者 + 阈值 + 近 7 天策展统计）与 config（当前生效配置）。
// 执行类命令暂不提供（sweep/slim 随官方折叠压力路径自动执行；0.3.0 M5/M6 落地后按需评估手动触发）。
//
// 2026-09-21（MAID-B12/B14）：status 从「最近一次结果」改为**历史分布 + 本会话折叠深度**——
// 只报最近一次会形成幸存者偏差（实测：只查最近 12 行全是 4/4，误判为「保护 100% 有效」）。

import { summarizePinHistory } from './anchor.mjs'
import { summarizeFoldVerify } from './fold-verify.mjs'

const USAGE = [
  'Usage: /context-maid <verb>',
  '  status         查看引擎提供者、阈值映射、近 7 天策展统计、PIN 校验历史分布、本会话折叠深度与最近记录',
  '  config         查看当前生效配置',
  '  slim-now       手动执行一次前置清理（eventSlim 增量瘦身 + sweep 清扫；0.3.0 验证/诊断口）',
  '  help           本帮助',
].join('\n')

/**
 * 注册 /context-maid 命令（commands 可选服务，缺失等待其就绪——对齐 work-continuity 模式）。
 * @param {object} ctx
 * @param {object} deps - { config, audit, getCompaction }
 */
export function registerMaidCommands(ctx, deps) {
  const { config, audit, getCompaction } = deps
  const withService = (name, fn) => {
    const existing = ctx.get(name)
    if (existing !== undefined && existing !== null) { fn(existing); return }
    const off = ctx.on('internal/service', (svcName) => {
      if (svcName !== name) return
      const svc = ctx.get(name)
      if (svc !== undefined && svc !== null) { off(); fn(svc) }
    })
  }

  withService('commands', (commands) => {
    if (!commands || typeof commands.register !== 'function') return
    commands.register({
      name: 'context-maid',
      description: '上下文策展状态与配置查看',
      input: { hint: '/context-maid status | config | help' },
      handler: async (invocation) => {
        try {
          const raw = String(invocation?.rawInput ?? '').trim()
          const [verb] = raw.split(/\s+/)
          if (verb === 'status') return { kind: 'success', text: renderStatus(ctx, config, audit, getCompaction, invocation) }
          if (verb === 'config') return { kind: 'success', text: renderConfig(config) }
          if (verb === 'slim-now') return runSlimNow(ctx, invocation, getCompaction)
          return { kind: 'success', text: USAGE }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: 'context-maid error: ' + message }
        }
      },
    })
    ctx.logger?.info?.('[context-maid] /context-maid command registered')
  })
}

/** 手动前置清理（0.3.0 诊断/验证口）：eventSlim + sweep 全跑一次并回报统计。 */
async function runSlimNow(ctx, invocation, getCompaction) {
  try {
    const comp = getCompaction()
    if (!comp || typeof comp.runPreCleanup !== 'function') {
      return { kind: 'error', text: 'context-maid: 引擎未接管（runPreCleanup 不可用）——engine 旁路或 maid 0.3.0 未加载' }
    }
    const agent = invocation?.agent
    if (!agent?.session) {
      return { kind: 'error', text: 'context-maid: 无法解析当前会话（invocation.agent.session 缺失）' }
    }
    const out = await comp.runPreCleanup(agent)
    const es = out?.eventSlim
    const sw = out?.sweep
    const lines = ['[context-maid] slim-now 完成']
    lines.push('eventSlim: ' + (es?.error ? 'ERROR: ' + es.error : es ? es.pruned + ' pruned / ' + es.processed + ' checked（charsRemoved ' + es.charsRemoved + '）' : '跳过（未启用或无 pruner）'))
    lines.push('sweep: ' + (sw?.error ? 'ERROR: ' + sw.error : sw ? sw.swept + ' swept / ' + sw.candidates + ' candidates（charsRemoved ' + sw.charsRemoved + '）' : '跳过（未启用或节流中）'))
    return { kind: 'success', text: lines.join('\n') }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: 'context-maid slim-now error: ' + message }
  }
}

function renderConfig(config) {
  const lines = ['[context-maid] config']
  const flat = {}
  for (const [k, v] of Object.entries(config)) flat[k] = v
  for (const [k, v] of Object.entries(flat).sort()) lines.push('  ' + k + ' = ' + v)
  return lines.join('\n')
}

function renderStatus(ctx, config, audit, getCompaction, invocation) {
  const lines = ['[context-maid] status']
  let engineNote = ''
  try {
    const comp = getCompaction()
    if (comp) {
      const name = comp?.constructor?.name ?? ''
      engineNote = name === 'MaidCompactionEngine'
        ? 'ctx.compaction = MaidCompactionEngine（maid 提供，阈值映射生效）'
        : 'ctx.compaction = ' + name + '（maid 未接管；如需 maid 阈值需 disable 官方 compaction-basic）'
    } else {
      engineNote = 'ctx.compaction 未提供（宿主未挂载任何引擎）'
    }
  } catch (e) { engineNote = 'ctx.compaction 读取失败: ' + (e?.message ?? e) }
  lines.push('engine: ' + engineNote)
  lines.push('userRatio: ' + config['trigger.userRatio'] + '（→ 官方 thresholdRatio）')
  lines.push('enabled: ' + config.enabled)
  // 0.3.0 诊断：引擎清理 tick + pruner 提供者
  try {
    const comp = getCompaction()
    if (comp && typeof comp.cleanupStats === 'function') {
      const st = comp.cleanupStats()
      lines.push('cleanupTicks: ' + st.ticks + (st.lastAt ? '（last ' + new Date(st.lastAt).toISOString().slice(11, 19) + ' UTC）' : '') + ' eventSlim=' + config['trigger.eventSlim'] + ' sweep=' + (config['sweep.enabled'] === true))
      if (st.lastResult && (st.lastResult.eventSlim || st.lastResult.sweep)) {
        const es = st.lastResult.eventSlim
        const sw = st.lastResult.sweep
        lines.push('lastCleanup: slim=' + (es ? es.pruned + ' pruned/' + es.processed + ' checked' : 'skip') + ' sweep=' + (sw ? sw.swept + ' swept/' + sw.candidates + ' cand' : 'skip'))
      }
    }
    let prunerNote = '未探测'
    try {
      const p = ctx.get('toolResultPruner')
      prunerNote = p ? (p.constructor?.name || '实例') : '无（toolResultPruner 未注册）'
    } catch { prunerNote = '解析失败' }
    lines.push('pruner: ' + prunerNote)
  } catch { /* 诊断失败不阻断 */ }

  let stats = []
  try { stats = typeof audit?.stats === 'function' ? audit.stats(7) : [] } catch {}
  if (stats.length) {
    lines.push('近 7 天策展:')
    for (const s of stats) {
      lines.push('  ' + s.op + ': ' + s.n + ' 次' + (s.saved ? '（约省 ' + s.saved + ' tokens）' : ''))
    }
  } else {
    lines.push('近 7 天策展: （无记录）')
  }
  // C6（2026-09-09）+ MAID-B12（2026-09-21）：PIN 校验改报**近 N 次分布**。
  // 只看最近一次 = 幸存者偏差；实测 18 次里既有 4/4 也有 0/4 全丢，只看一条会得出相反结论。
  try {
    const all = typeof audit?.recent === 'function' ? audit.recent(200) : []
    const h = summarizePinHistory(all, { maxRuns: 20 })
    if (h.runs > 0) {
      const dist = h.buckets.map((b) => b.key + ' ×' + b.n).join('、')
      lines.push('PIN 锚点校验（近 ' + h.runs + ' 次）: ' + (dist || '（全为不可校验）')
        + (h.noAnchorRuns > 0 ? ' · 无锚点 ' + h.noAnchorRuns + ' 次' : '')
        + (h.verifiableRatio === null ? '' : ' · 可校验 ' + Math.round(h.verifiableRatio * 100) + '%'))
      if (h.zeroRuns > 0) {
        lines.push('  ⚠ ' + h.zeroRuns + ' 次把 PIN 锚点全丢了（0/N）——软保护不是「永远有效」')
      }
    } else {
      lines.push('PIN 锚点校验: （无记录）')
    }
  } catch { /* 诊断失败不阻断 */ }
  // 折叠后约束校验（2026-09-25）：三态分布——比「命中率」更直接回答「约束还在不在」。
  // 未注入 / 无从校验 单独列：这两个都不是「模型丢了」，混进 lost 会误导排查方向。
  try {
    const rows = typeof audit?.recent === 'function' ? audit.recent(200) : []
    const fv = summarizeFoldVerify(rows, { maxRuns: 20 })
    if (fv.runs > 0) {
      lines.push('折叠后约束校验（近 ' + fv.runs + ' 次）: ok ' + fv.ok + ' · partial ' + fv.partial + ' · lost ' + fv.lost
        + (fv.unverifiable > 0 ? ' · 无从校验 ' + fv.unverifiable : '')
        + (fv.notInjected > 0 ? ' · 未注入 ' + fv.notInjected : '')
        + (fv.unstated > 0 ? ' · 旧记录 ' + fv.unstated : ''))
      if (fv.lost > 0) {
        lines.push('  ⚠ ' + fv.lost + ' 次把约束完全丢了（lost）——软保护不是「永远有效」')
      }
    }
  } catch { /* 诊断失败不阻断 */ }
  // MAID-B14（2026-09-21）：本会话折叠深度。深度是「这个会话还要不要继续」的判据，
  // 此前只能靠 count(op=fold) group by session_id 反推。
  try {
    const sid = String(invocation?.agent?.session?.id ?? '')
    if (!sid) {
      lines.push('foldDepth: （无法解析当前会话）')
    } else {
      const rows = typeof audit?.recent === 'function' ? audit.recent(500) : []
      let n = 0
      let maxDepth = 0
      for (const r of rows) {
        if (!r || r.op !== 'fold' || String(r.sessionId ?? '') !== sid) continue
        n += 1
        const m = /"foldDepth"\s*:\s*(\d+)/.exec(String(r.detail ?? ''))
        if (m) maxDepth = Math.max(maxDepth, Number(m[1]))
      }
      const depth = Math.max(n, maxDepth)
      lines.push('foldDepth: ' + depth + '（本会话）'
        + (depth > 10 ? '  ⚠ 超过阈值 10——该考虑收尾或开新会话了' : ''))
    }
  } catch { /* 诊断失败不阻断 */ }
  let recent = []
  try { recent = typeof audit?.recent === 'function' ? audit.recent(5) : [] } catch {}
  for (const r of recent) {
    lines.push('  ' + new Date(r.ts).toISOString().slice(0, 19) + ' ' + r.op
      + (r.range ? ' [' + r.range + ']' : '') + (r.summary ? ' ' + r.summary.slice(0, 60) : ''))
  }
  return lines.join('\n')
}

export default registerMaidCommands
