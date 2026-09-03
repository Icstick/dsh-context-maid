// test/smoke.test.mjs — M1 骨架 smoke 测试
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('模块可加载且导出契约完整', async () => {
  const mod = await import('../src/index.mjs')
  assert.equal(mod.name, 'context-maid')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.Config, 'Config schema 存在')
})

test('Config 默认值符合设计（实例化验证）', async () => {
  const { Config } = await import('../src/index.mjs')
  // schemastery：解析默认值（无输入 → 全默认）
  const cfg = Config()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg['trigger.userRatio'], 0.4)
  assert.equal(cfg['trigger.minTokens'], 30000)
  assert.equal(cfg['sweep.aggressive'], false)
  assert.equal(cfg['summarization.provider'], '')
  assert.equal(cfg['summarization.allowLocal'], true)
  assert.equal(cfg['pin.enabled'], true)
  assert.equal(cfg['archive.enabled'], true)
})
