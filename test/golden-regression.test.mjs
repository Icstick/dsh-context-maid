// test/golden-regression.test.mjs — 黄金回归集：历史真实问题防复发（P0，2026-09-07）。
// 语义锚点（M2/M3 历史修复）：
//   CM1 失败/错误 tool 结果不得被当作成功知识（failed-retry 清理语义前提）
//   CM2 内容分类：JSON/错误/日志 与正文区分（防止巨型 tool JSON 当正文知识吞入）
//   CM3 同工具重复读取清理的指纹语义：路径类参数参与指纹，避免误判
//   CM4 secret 红act（归档/摘要必红act——防 ACP secret-block 与泄漏）
//   CM5 钉扎软保护只收高 authority（user_explicit/user_correction/system_policy）
//   CM6 归档敏感度契约为 private（非 secret——防被 store 挡在门外）
// 运行：node --test test/golden-regression.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectContentType, jsonSkeleton } from '../src/slimmer.mjs'
import { toolFingerprint, isFailureResult } from '../src/sweeper.mjs'
import { collectPinnedFacts } from '../src/pinner.mjs'
import { redactSecrets } from '../src/archiver.mjs'

const ev = (type, seq, data) => ({ type, seq, data: { ...data } })

// ---------- CM1：失败结果识别 ----------
test('CM1 失败/错误 tool 结果必须可识别（不得当成功知识）', () => {
  for (const text of ['Error: ENOENT no such file', 'error: build failed', 'Traceback (most recent call last)', 'fatal: unable to connect, access denied', '✖ 12 tests failed']) {
    const e = ev('tool/result', 1, { message: { content: [{ type: 'text', text }] } })
    assert.equal(isFailureResult(e), true, text)
  }
  const ok = ev('tool/result', 2, { message: { content: [{ type: 'text', text: 'done successfully, 10 files' }] } })
  assert.equal(isFailureResult(ok), false)
})

// ---------- CM2：内容分类 ----------
test('CM2 巨型 JSON/错误输出与正文区分（压缩决策前提）', () => {
  assert.equal(detectContentType('{"a":1,"b":[1,2,3]}'), 'json')
  assert.equal(detectContentType('[{"x":1},{"x":2}]'), 'json')
  assert.equal(detectContentType('Error: boom\ntraceback line1'), 'error')
  assert.equal(detectContentType('stderr: boom'), 'error')
  assert.equal(detectContentType('普通正文内容'), 'plain')
})

// ---------- CM3：指纹路径语义 ----------
test('CM3 路径/URL 类参数进指纹：同工具读不同文件不误判为重复', () => {
  const a = ev('tool/call', 1, { name: 'read', args: { file_path: 'a.ts' } })
  const b = ev('tool/call', 2, { name: 'read', args: { file_path: 'b.ts' } })
  assert.notEqual(toolFingerprint(a), toolFingerprint(b))
  // 无路径参数时同工具同键集合 → 同指纹（后序结果取代前序的清理语义）
  const c = ev('tool/call', 3, { name: 'list', args: {} })
  const d = ev('tool/call', 4, { name: 'list', args: {} })
  assert.equal(toolFingerprint(c), toolFingerprint(d))
  // 未知工具/空事件 → 空指纹（不参与清理）
  assert.equal(toolFingerprint(null), '')
  assert.equal(toolFingerprint({ type: 'x' }), '')
})

// ---------- CM4：secret 红act ----------
test('CM4 归档/摘要必经 secret 红act（token/密码/PAT/JWT/私钥）', () => {
  const cases = [
    'token: 5a8cda01e84c3f6eed1953998737a59588f9d97d27d520c5',
    'password=SuperSecret123456',
    'api_key = "sk-abcdefghijklmnopqrstuvwx"',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '-----BEGIN RSA PRIVATE KEY-----',
  ]
  for (const c of cases) {
    const out = redactSecrets(c)
    assert.ok(!/[A-Za-z0-9_\-]{16,}/.test(out.replace('[redacted]', '')), 'leak: ' + c)
    assert.ok(out.includes('[redacted]'), 'not redacted: ' + c)
  }
  // 普通文本不受影响
  assert.equal(redactSecrets('今天天气不错，用了 pnpm install'), '今天天气不错，用了 pnpm install')
})

// ---------- CM5：钉扎权威过滤 ----------
test('CM5 钉扎只收高 authority 事实，agent 推断/外部信息不钉', async () => {
  const acp = {
    query: async () => ({ items: [
      { authority: 'user_explicit', content: '必须用 pnpm' },
      { authority: 'user_correction', content: '不要用 yarn' },
      { authority: 'system_policy', content: '会话预算上限 8000' },
      { authority: 'agent_inference', content: '我猜用户喜欢 bun' },
      { authority: 'external_information', content: 'npm 官网文档说…' },
      { authority: 'single_observation', content: '看到 package.json 有 bun.lock' },
      { authority: 'user_explicit', content: 'x'.repeat(600) }, // 超长不收
    ] }),
  }
  const ctx = { get: (n) => (n === 'acp' ? acp : undefined) }
  const facts = await collectPinnedFacts(ctx, { extra: ['自定义钉扎'] })
  const texts = facts.join('\n')
  assert.ok(texts.includes('[ACP user_explicit] 必须用 pnpm'))
  assert.ok(texts.includes('[ACP user_correction] 不要用 yarn'))
  assert.ok(texts.includes('[ACP system_policy]'))
  assert.ok(!texts.includes('我猜用户喜欢 bun'), 'agent_inference 不得钉扎')
  assert.ok(!texts.includes('npm 官网'), 'external_information 不得钉扎')
  assert.ok(!texts.includes('bun.lock'), 'single_observation 不得钉扎')
  assert.ok(!texts.includes('x'.repeat(600).slice(0, 60)), '超长事实不钉扎')
  assert.ok(texts.includes('[user-pinned] 自定义钉扎'), 'extra 全收')
})

// ---------- CM6：jsonSkeleton 有界 ----------
test('CM6 jsonSkeleton 输出有界且保留结构信息', () => {
  const big = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'item' + i, nested: { a: 1, b: [1, 2, 3] } })) })
  const sk = jsonSkeleton(big, 400)
  assert.ok(sk.length <= 400 + 10, 'skeleton bounded')
  assert.ok(sk.length < big.length, 'skeleton shrinks')
  assert.ok(/items|id|name/.test(sk), 'structure hints kept')
})
