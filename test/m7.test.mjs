// test/m7.test.mjs — M7：收口（B9 死键删除 + B10 PIN 预算 + 版本）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPinInstruction, collectPinnedFacts, PIN_BUDGET_CHARS } from '../src/pinner.mjs'

// —— B10：PIN 预算 ——
test('buildPinInstruction：预算内原样；超预算整条截断 + 计数标注', () => {
  const short = buildPinInstruction(['必须用 pnpm', '不要用 yarn'])
  assert.ok(short.includes('必须用 pnpm'))
  assert.ok(!short.includes('+more'))
  // 小预算（强制截断）
  const long = buildPinInstruction(['aaaa ' + 'x'.repeat(200), 'bbbb ' + 'y'.repeat(200)], 100)
  assert.ok(long.includes('+2 more facts omitted'), '超预算计数标注（两条均超）')
  assert.ok(!long.includes('aaaa') && !long.includes('bbbb'), '超预算整条丢弃（保语义完整）')
  // 空
  assert.equal(buildPinInstruction([]), '')
  assert.equal(buildPinInstruction(null), '')
})

test('PIN_BUDGET_CHARS = 1800（≈600 token）', () => {
  assert.equal(PIN_BUDGET_CHARS, 1800)
})

test('预算截断保 authority 优先级（收集顺序即优先级：user_explicit 在前）', async () => {
  // 每条 <500 字符（collectPinnedFacts 单条上限）；三条入列 ~1410 字符，第四条超出 1800 截断
  const mk = (p, i) => p + ' ' + 'v'.repeat(440) + ' #' + i
  const acp = {
    queryObservations: async () => ({ items: [
      { authority: 'user_explicit', text: mk('u1', 1) },
      { authority: 'user_explicit', text: mk('u2', 2) },
      { authority: 'user_correction', text: mk('c1', 3) },
      { authority: 'system_policy', text: mk('s1', 4) },
    ] }),
  }
  const ctx = { get: (n) => (n === 'acp' ? acp : undefined) }
  const facts = await collectPinnedFacts(ctx, {})
  const out = buildPinInstruction(facts)
  assert.ok(out.includes('[ACP user_explicit] u1'), '高优先级保留')
  assert.ok(out.includes('[ACP user_explicit] u2'), '高优先级保留')
  assert.ok(!out.includes('[ACP system_policy]'), '最低优先级被预算截断')
  assert.ok(out.includes('+1 more facts omitted'), '截断计数')
})

// —— B9：死键已从 Config 删除 ——
test('Config 无死键：trigger.minTokens / pin.inject / summarization.allowLocal', async () => {
  const mod = await import('../src/index.mjs')
  const cfg = mod.Config()
  assert.equal(cfg['trigger.minTokens'], undefined, 'minTokens 已删')
  assert.equal(cfg['pin.inject'], undefined, 'pin.inject 已删')
  assert.equal(cfg['summarization.allowLocal'], undefined, 'allowLocal 已删')
  assert.equal(cfg['trigger.eventSlim'], true, 'eventSlim 保留且默认开')
  assert.equal(cfg['sweep.enabled'], false, 'sweep.enabled 保留默认关')
})
