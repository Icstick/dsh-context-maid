// src/maid-summarizer.mjs — M4：知识感知/智能路由摘要调用。
//
// 官方 summarizeWithLlm 在 npm 发布物中不可达（仅在 workspace 源码），
// 因此 maid 复刻其调用语义（同 prompt / 同 BlockAssembler / 同 finish 检查），
// 但目标解析走 maid 的智能路由链：
//   1. 注册的 resolver（外部智能路由插件可 registerSummarizationResolver 接入）
//   2. → maid Config 显式 summarization.provider/model
//   3. → 最近路由的对话模型（官方回落）
// 复刻自 @deepseek-ai/dsh-compaction-basic src/summarizer.ts（0.1.2-alpha.1），
// 同步注意：若官方更新指令模板，此处需跟随。

import { contentHasImage, createUserMessage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'

/** 官方摘要指令（同步自 compaction-basic/summarizer.ts） */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n')

/** finish 非 stop → 抛错（对齐官方 fail-closed） */
function finishError(finish) {
  if (!finish) return undefined
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? 'summarization failed')
      error.code = finish.failure?.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/**
 * 用指定 provider/model 跑一次摘要（maid 复刻官方调用语义）。
 * @param {object} ctx - cordis Context（ctx.llm 必需）
 * @param {object} target - { provider, model, maxTokens? }
 * @param {object} input - { system?, tools?, messages }
 * @param {object} agent - { session }
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} SummaryResult 形状
 */
export async function maidSummarizeWithLlm(ctx, target, input, agent, signal) {
  const maxTokens = target.maxTokens ?? 8192
  const assembler = new BlockAssembler()
  const messages = [
    ...(input?.messages ?? []),
    createUserMessage({
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-context-maid' },
    }),
  ]
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input?.system === undefined ? {} : { system: input.system },
    ...input?.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens,
    sessionId: agent?.session?.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = rawOutput.filter((b) => b.type === 'text')
  if (contentHasImage(rawOutput)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  if (!summary.some((b) => b.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

export default maidSummarizeWithLlm
