// dsh-context-maid — function plugin entry。
//
// 自动上下文策展：五级内容分级（PIN/KEEP/SLIM/SWEEP/FOLD）→ 清理主战场
// （tool 输出瘦身 + 无效日志清理）→ 钉扎保护（工作流/记忆/用户重点）→ 先归档后压缩。
// 设计文档：docs/dsh-context-maid-design.md（v0.2，2026-09-03 用户拍板）
//
// M1：引擎接管（阈值映射）+ 审计库 + /context-maid 命令。
//   装配注意：maid 继承 BasicCompactionEngine 并作为 ctx.compaction 提供者时，
//   宿主 profile 必须 disable 官方 compaction-basic（同 key 只能一个提供者）。

import z from '@deepseek-ai/schemastery'
import path from 'node:path'
import { MaidCompactionEngine } from './engine.mjs'
import { openMaidAudit } from './audit.mjs'
import { registerMaidCommands } from './commands.mjs'
import { MaidSlimmer } from './slimmer.mjs'
import { registerArchiver } from './archiver.mjs'

export const name = 'context-maid'
export const inject = []

export const Config = z.object({
  enabled: z.boolean().default(true),
  // —— 触发（M1：userRatio 映射官方 thresholdRatio）——
  'trigger.userRatio': z.number().step(0.01).min(0.05).max(0.95).default(0.4),
  'trigger.minTokens': z.number().step(1).min(0).default(30000),
  'trigger.eventSlim': z.boolean().default(true),
  // —— 瘦身（M2）——
  'slim.thresholdChars': z.number().step(1).min(100).default(4000),
  'slim.tailChars': z.number().step(1).min(0).default(800),
  'slim.headChars': z.number().step(1).min(0).default(800),
  // —— 清理（M2）——
  'sweep.enabled': z.boolean().default(true),
  'sweep.aggressive': z.boolean().default(false), // 保留意见：是否加审批门待用户后续定
  // —— 压缩 ——
  'fold.retainRatio': z.number().step(0.01).min(0.01).max(0.9).default(0.16),
  // —— 钉扎（M3）——
  'pin.enabled': z.boolean().default(true),
  'pin.inject': z.boolean().default(true),
  'pin.extra': z.array(z.string()).default([]), // 用户显式钉扎清单（如 ['必须用 pnpm']）
  // —— 归档（M3）——
  'archive.enabled': z.boolean().default(true),
  // —— 摘要模型（用户 2026-09-03：可配便宜/本地模型 + 智能路由端点）——
  'summarization.provider': z.string().default(''),
  'summarization.model': z.string().default(''),
  'summarization.allowLocal': z.boolean().default(true),
  // —— maid 自身 ——
  auditDir: z.string().default(''), // 空 → $DSH_HOME/context-maid（与 ACP ledger 同层）
  debug: z.boolean().default(false),
})

export function apply(ctx, config = {}) {
  // —— 装配纪律（cordis Service 同 key 只能一个提供者）——
  //   ctx.compaction：maid 继承 BasicCompactionEngine 注册；若宿主未 disable 官方
  //     compaction-basic，官方已先注册 → cordis 抛 "service has been registered"。
  //     防呆：检测到占用 → warn 并跳过引擎接管（其余模块仍运行）；文档要求
  //     profile patch 加 `- id: compaction-basic\n  disabled: true`（同 tool-result-pruner）。
  let engine = null
  try {
    const existing = typeof ctx.get === 'function' ? ctx.get('compaction') : undefined
    if (existing) {
      ctx.logger?.warn?.('[context-maid] ctx.compaction 已被 ' + (existing?.constructor?.name ?? '其他实现')
        + ' 占用——maid 未接管。请在 profile patch disable 官方 compaction-basic 后重启（见 README）')
    } else {
      engine = new MaidCompactionEngine(ctx, config)
      ctx.logger?.info?.('[context-maid] MaidCompactionEngine 已注册为 ctx.compaction')
    }
  } catch (e) {
    ctx.logger?.warn?.('[context-maid] 引擎接管失败（' + (e?.message ?? e) + '）——继续旁路模式')
  }

  // MaidSlimmer 注册为 ctx.toolResultPruner（M2；同样要求宿主 disable 官方 tool-result-pruner）
  let slimmer = null
  try {
    const existing = typeof ctx.get === 'function' ? ctx.get('toolResultPruner') : undefined
    if (existing) {
      ctx.logger?.warn?.('[context-maid] ctx.toolResultPruner 已被占用——maid 瘦身器未接管（如需 maid 瘦身请 disable 官方 tool-result-pruner）')
    } else {
      slimmer = new MaidSlimmer(ctx, config)
      ctx.logger?.info?.('[context-maid] MaidSlimmer 已注册为 ctx.toolResultPruner')
    }
  } catch (e) {
    ctx.logger?.warn?.('[context-maid] 瘦身器注册失败（' + (e?.message ?? e) + '）')
  }

  // 审计库 + 命令
  const auditDir = config.auditDir || path.join(process.env.DSH_HOME || '', 'context-maid')
  const audit = openMaidAudit(auditDir)

  // M3：归档——消费 compaction/summary → ACP ledger（摘要即证据；ACP 可选，离线跳过）
  registerArchiver(ctx, { enabled: config['archive.enabled'] !== false, audit })

  registerMaidCommands(ctx, {
    config,
    audit,
    getCompaction: () => { try { return ctx.get('compaction') } catch { return undefined } },
  })

  ctx.logger?.info?.('[context-maid] loaded; userRatio=' + config['trigger.userRatio']
    + ' enabled=' + (config.enabled !== false)
    + ' engine=' + (engine ? 'maid' : '旁路') + ' slimmer=' + (slimmer ? 'maid' : '官方/无'))

  ctx.effect(() => () => {
    try { audit.close() } catch {}
  })
}

export default { name, Config, apply }
