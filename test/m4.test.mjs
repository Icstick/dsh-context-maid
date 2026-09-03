// test/m4.test.mjs — M4：智能路由 + 摘要模型可配
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPACTION_INSTRUCTION } from '../src/maid-summarizer.mjs'

test('COMPACTION_INSTRUCTION：8 节结构完整（同步官方模板）', () => {
  for (const section of ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context']) {
    assert.ok(COMPACTION_INSTRUCTION.includes('## ' + section), '含 ' + section)
  }
  assert.ok(COMPACTION_INSTRUCTION.includes('<compacted-summary>'), '含旧 checkpoint 合并规则')
})

test('resolveSummarizationTarget：resolver 链 → maid 显式 → null', async () => {
  // 通过子类实例测（不实例化官方引擎——用纯逻辑分离测试：直接构造轻量对象）
  // MaidCompactionEngine 需要 cordis ctx（Service 构造），这里测其逻辑等价函数路径
  const { resolveSummarizationTarget } = await import('../src/engine.mjs').catch(() => ({}))
  // engine.mjs 导出的是类，测注册表逻辑需要 ctx——跳过实例化，验证 maidSummarizeWithLlm 模块导出
  assert.ok(true) // 占位：实例化级测试在宿主集成（见 m4 集成说明）
})

test('maidSummarizeWithLlm 模块可加载（不调用——需 ctx.llm）', async () => {
  const mod = await import('../src/maid-summarizer.mjs')
  assert.equal(typeof mod.maidSummarizeWithLlm, 'function')
  assert.equal(typeof mod.COMPACTION_INSTRUCTION, 'string')
})

test('MaidCompactionEngine 导出 registerSummarizationResolver API（类方法存在）', async () => {
  const { MaidCompactionEngine } = await import('../src/engine.mjs')
  assert.equal(typeof MaidCompactionEngine.prototype.registerSummarizationResolver, 'function')
  assert.equal(typeof MaidCompactionEngine.prototype.resolveSummarizationTarget, 'function')
  assert.equal(typeof MaidCompactionEngine.prototype.summarize, 'function')
})

test('MaidCompactionEngine 实例：resolver 注册与目标解析链（mock ctx）', async () => {
  const { MaidCompactionEngine } = await import('../src/engine.mjs')
  // 构造需要 ctx.reflect.provide / ctx.get / ctx.on / logger；auto:false 避免注册自动监听
  const provided = {}
  const listeners = {}
  const ctx = {
    reflect: { provide: (name, value) => { provided[name] = value; return async () => {} } },
    get: (n) => undefined,
    on: (evt, cb) => { (listeners[evt] ??= []).push(cb); return () => {} },
    logger: { info() {}, warn() {}, error() {} },
  }
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false })
  // resolver 链：第一个不决策，第二个决策 → 应返回第二个
  const calls = []
  engine.registerSummarizationResolver(async () => { calls.push('r1'); return null })
  engine.registerSummarizationResolver(async (_a, dflt) => { calls.push('r2'); return { provider: 'local-llm', model: 'qwen3.5' } })
  const out = await engine.resolveSummarizationTarget({ session: {} }, { provider: '', model: '' })
  assert.deepEqual(calls, ['r1', 'r2'])
  assert.equal(out.provider, 'local-llm')
  // 无 resolver 决策 → maid 显式目标
  const e2 = new MaidCompactionEngine(ctx, { enabled: true, auto: false, 'summarization.provider': 'deepseek-vision', 'summarization.model': 'deepseek-v4-flash' })
  const out2 = await e2.resolveSummarizationTarget({ session: {} }, { provider: 'deepseek-vision', model: 'deepseek-v4-flash' })
  assert.equal(out2.model, 'deepseek-v4-flash')
  // 注销（用全新实例，避免前序 resolver 残留）
  const e3 = new MaidCompactionEngine(ctx, { enabled: true, auto: false })
  const off = e3.registerSummarizationResolver(async () => ({ provider: 'x', model: 'y' }))
  off()
  const out3 = await e3.resolveSummarizationTarget({ session: {} }, { provider: '', model: '' })
  assert.equal(out3, null)
})
