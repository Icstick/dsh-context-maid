// test/m3.test.mjs — M3：钉扎软保护 + 归档
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectPinnedFacts, buildPinInstruction } from '../src/pinner.mjs'
import { summaryTextOf, registerArchiver } from '../src/archiver.mjs'

// —— pinner ——
test('collectPinnedFacts：ACP 高 authority + work goal + extra 清单', async () => {
  const acp = {
    query: async () => ({ items: [
      { authority: 'user_explicit', content: '必须用 pnpm' },
      { authority: 'user_correction', content: '不要用 yarn' },
      { authority: 'single_observation', content: '普通观察不进 PIN' },
      { authority: 'user_explicit', content: '必须用 pnpm' }, // 去重
    ] }),
  }
  const work = { get: () => ({ goal: '完成 maid M3' }) }
  const ctx = { get: (n) => (n === 'acp' ? acp : n === 'work' ? work : undefined) }
  const facts = await collectPinnedFacts(ctx, { cwd: 'D:/ws/x', extra: ['保留部署脚本'] })
  assert.ok(facts.some((f) => f.includes('必须用 pnpm')), '含 user_explicit')
  assert.ok(facts.some((f) => f.includes('不要用 yarn')), '含 user_correction')
  assert.ok(!facts.some((f) => f.includes('普通观察')), '低 authority 不进 PIN')
  assert.ok(facts.some((f) => f.includes('完成 maid M3')), '含 work goal')
  assert.ok(facts.some((f) => f.includes('保留部署脚本')), '含 extra')
  const pnpmCount = facts.filter((f) => f.includes('必须用 pnpm')).length
  assert.equal(pnpmCount, 1, '去重')
})

test('collectPinnedFacts：服务缺失不抛（fail-open）', async () => {
  const ctx = { get: () => undefined }
  const facts = await collectPinnedFacts(ctx, {})
  assert.deepEqual(facts, [])
})

test('buildPinInstruction：空事实返回空串；有事实生成指令块', () => {
  assert.equal(buildPinInstruction([]), '')
  assert.equal(buildPinInstruction(null), '')
  const out = buildPinInstruction(['[ACP user_explicit] 必须用 pnpm'])
  assert.ok(out.includes('MUST be reflected'))
  assert.ok(out.includes('必须用 pnpm'))
})

// —— archiver ——
test('summaryTextOf：提取文本块（字符串 JSON / 数组 / 纯字符串）', () => {
  const arr = [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }]
  assert.equal(summaryTextOf({ data: { summary: JSON.stringify(arr) } }), 'line1\nline2')
  assert.equal(summaryTextOf({ data: { summary: arr } }), 'line1\nline2')
  assert.equal(summaryTextOf({ data: { summary: 'plain' } }), 'plain')
  assert.equal(summaryTextOf({ data: {} }), '')
})

test('registerArchiver：compaction/summary → acp.append + audit 留痕', async () => {
  const appended = []
  const acp = { append: (input) => { appended.push(input); return { id: 'obs_maid1' } } }
  const auditRows = []
  const audit = { append: (r) => auditRows.push(r) }
  const listeners = {}
  const ctx = {
    get: (n) => (n === 'acp' ? acp : undefined),
    on: (evt, cb) => { (listeners[evt] ??= []).push(cb); return () => {} },
    logger: { info() {}, warn() {}, error() {} },
  }
  registerArchiver(ctx, { enabled: true, audit })
  const event = {
    type: 'compaction/summary',
    seq: 42,
    data: {
      compactionId: 'cid_1',
      shadowedRange: { start: 1, end: 100 },
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 50000,
      summary: JSON.stringify([{ type: 'text', text: 'checkpoint 摘要内容' }]),
    },
  }
  listeners['session/event'][0]({ id: 'sess1' }, event)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].sourceClass, 'agent_authored')
  assert.equal(appended[0].claimDomain, 'experience')
  assert.ok(appended[0].content.includes('checkpoint 摘要内容'))
  assert.equal(appended[0].sourceRef.maidCompactionId, 'cid_1')
  assert.equal(auditRows.length, 1)
  assert.equal(auditRows[0].op, 'fold')
  assert.equal(auditRows[0].archiveIds[0], 'obs_maid1')
})

test('registerArchiver：非 summary 事件 / ACP 离线 / disabled → 不动作', async () => {
  let appendCalled = 0
  const acp = { append: () => { appendCalled++; return { id: 'x' } } }
  const listeners = {}
  const ctx = { get: () => acp, on: (e, cb) => { (listeners[e] ??= []).push(cb) }, logger: { warn() {} } }
  registerArchiver(ctx, { enabled: true, audit: { append() {} } })
  listeners['session/event'][0]({}, { type: 'turn/end' })
  assert.equal(appendCalled, 0, '非 summary 事件不调')
  listeners['session/event'][0]({}, { type: 'compaction/summary', data: { summary: 'no acp check now' } })
  assert.equal(appendCalled, 1, 'ACP 在线 + summary → 会调')

  const listeners2 = {}
  const ctx2 = { get: () => undefined, on: (e, cb) => { (listeners2[e] ??= []).push(cb) }, logger: { warn() {} } }
  let called = 0
  registerArchiver(ctx2, { enabled: true, audit: { append() { called++ } } })
  listeners2['session/event'][0]({}, { type: 'compaction/summary', data: { summary: 'x' } })
  assert.equal(called, 0, 'ACP 离线 → 不 append 不审计')
})
