// src/commands.mjs — /context-maid 命令族：status / config / help
//
// M1：status（引擎提供者 + 阈值 + 近 7 天策展统计）与 config（当前生效配置）。
// run/slim-now 等执行命令随对应里程碑（M2 sweeper/slimmer）加入。

const USAGE = [
  'Usage: /context-maid <verb>',
  '  status         查看引擎提供者、阈值映射、近 7 天策展统计与最近记录',
  '  config         查看当前生效配置',
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
          if (verb === 'status') return { kind: 'success', text: renderStatus(ctx, config, audit, getCompaction) }
          if (verb === 'config') return { kind: 'success', text: renderConfig(config) }
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

function renderConfig(config) {
  const lines = ['[context-maid] config']
  const flat = {}
  for (const [k, v] of Object.entries(config)) flat[k] = v
  for (const [k, v] of Object.entries(flat).sort()) lines.push('  ' + k + ' = ' + v)
  return lines.join('\n')
}

function renderStatus(ctx, config, audit, getCompaction) {
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
  let recent = []
  try { recent = typeof audit?.recent === 'function' ? audit.recent(5) : [] } catch {}
  for (const r of recent) {
    lines.push('  ' + new Date(r.ts).toISOString().slice(0, 19) + ' ' + r.op
      + (r.range ? ' [' + r.range + ']' : '') + (r.summary ? ' ' + r.summary.slice(0, 60) : ''))
  }
  return lines.join('\n')
}

export default registerMaidCommands
