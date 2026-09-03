// test/m2.test.mjs — M2：内容感知瘦身 + 无效日志识别
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectContentType, jsonSkeleton } from '../src/slimmer.mjs'
import { scanSweepCandidates, toolFingerprint, isFailureResult } from '../src/sweeper.mjs'

// —— detectContentType ——
test('detectContentType：JSON / 错误 / 日志 / 普通', () => {
  assert.equal(detectContentType('{"a": 1, "b": [1,2,3]}'), 'json')
  assert.equal(detectContentType('[{ "x": 1 }]'), 'json')
  assert.equal(detectContentType('Error: something failed\ntraceback...'), 'error')
  assert.equal(detectContentType('stderr: boom'), 'error')
  assert.equal(detectContentType('2026-09-03 10:00:00 INFO start'), 'log')
  assert.equal(detectContentType('hello world plain text'), 'plain')
})

// —— jsonSkeleton ——
test('jsonSkeleton：短 JSON 原样；长 JSON 骨架化保留结构与长度标注', () => {
  const short = '{"a": 1}'
  assert.equal(jsonSkeleton(short, 600), short)
  const big = JSON.stringify({ users: Array.from({ length: 50 }, (_, i) => ({ id: i, name: 'user' + i, tags: ['x', 'y'] })) })
  const out = jsonSkeleton(big, 300)
  assert.ok(out.length < big.length)
  assert.ok(out.includes('50') || out.includes('+47') || out.includes('more'), '应标注数组长度')
  assert.ok(out.startsWith('{'), '保留 JSON 骨架')
})

// —— MaidSlimmer 实例（需要 ctx，用轻量 mock）——
function mockCtx() {
  return { get: () => undefined, on: () => () => {}, logger: { info() {}, warn() {} }, reflect: { provide() {} } }
}

test('MaidSlimmer：超阈值 JSON tool 输出被骨架化', async () => {
  const { MaidSlimmer } = await import('../src/slimmer.mjs')
  const slimmer = new MaidSlimmer(mockCtx(), {})
  const big = JSON.stringify({ data: Array.from({ length: 200 }, (_, i) => ({ i, v: 'value-' + i })) })
  const blocks = [{ type: 'text', text: big }]
  const pruned = slimmer.pruneContent(blocks)
  assert.ok(pruned !== null, '应被瘦身')
  const text = pruned.find((b) => b.type === 'text').text
  assert.ok(text.length < big.length, '瘦身后更短')
  assert.ok(text.includes('maid slim'), '带 maid 标记')
})

test('MaidSlimmer：未超阈值返回 null（不动）', async () => {
  const { MaidSlimmer } = await import('../src/slimmer.mjs')
  const slimmer = new MaidSlimmer(mockCtx(), {})
  const small = 'x'.repeat(500)
  assert.equal(slimmer.pruneContent([{ type: 'text', text: small }]), null)
})

test('MaidSlimmer：错误类输出保留尾部（诊断信息）', async () => {
  const { MaidSlimmer } = await import('../src/slimmer.mjs')
  const slimmer = new MaidSlimmer(mockCtx(), { 'slim.headChars': 200, 'slim.tailChars': 200 })
  const body = 'Error: build failed\n' + 'x'.repeat(8000) + '\n  at final: the actual error detail is here'
  const pruned = slimmer.pruneContent([{ type: 'text', text: body }])
  assert.ok(pruned !== null)
  const text = pruned.find((b) => b.type === 'text').text
  assert.ok(text.includes('actual error detail'), '尾部错误细节保留')
})

// —— sweeper ——
function mkEvent(type, seq, data = {}) {
  return { type, seq, data: { ...data } }
}

test('toolFingerprint：路径类参数入指纹，忽略大参数', () => {
  const ev = mkEvent('tool/call', 1, { name: 'read_file', args: { file_path: 'C:/x/y.js', big: 'z'.repeat(5000) } })
  const fp = toolFingerprint(ev)
  assert.ok(fp.includes('read_file'))
  assert.ok(fp.includes('C:/x/y.js'))
  assert.ok(!fp.includes('z'.repeat(100)), '大参数不入指纹')
})

test('scanSweepCandidates：同工具同参数重复读取 → 前序标记 superseded', () => {
  const events = [
    mkEvent('tool/call', 1, { name: 'read_file', args: { file_path: 'a.js' } }),
    mkEvent('tool/result', 2, { name: 'read_file', args: { file_path: 'a.js' }, message: { content: [{ type: 'text', text: 'content v1' }] } }),
    mkEvent('tool/call', 3, { name: 'read_file', args: { file_path: 'a.js' } }),
    mkEvent('tool/result', 4, { name: 'read_file', args: { file_path: 'a.js' }, message: { content: [{ type: 'text', text: 'content v2' }] } }),
  ]
  const c = scanSweepCandidates(events)
  const superseded = c.filter((x) => x.kind === 'superseded-read')
  assert.equal(superseded.length, 1)
  assert.equal(superseded[0].startSeq, 2) // 前序 result 被清
})

test('scanSweepCandidates：失败→成功 同目标 → 失败结果标记 failed-retry', () => {
  const events = [
    mkEvent('tool/call', 1, { name: 'build', args: {} }),
    mkEvent('tool/result', 2, { name: 'build', args: {}, message: { content: [{ type: 'text', text: 'error: build failed' }] } }),
    mkEvent('tool/call', 3, { name: 'build', args: {} }),
    mkEvent('tool/result', 4, { name: 'build', args: {}, message: { content: [{ type: 'text', text: 'build ok' }] } }),
  ]
  const c = scanSweepCandidates(events)
  assert.ok(c.some((x) => x.kind === 'failed-retry' && x.startSeq === 2))
})

test('isFailureResult：错误特征识别', () => {
  const ev = mkEvent('tool/result', 1, { message: { content: [{ type: 'text', text: 'Error: ENOENT no such file' }] } })
  assert.equal(isFailureResult(ev), true)
  const ok = mkEvent('tool/result', 2, { message: { content: [{ type: 'text', text: 'done successfully' }] } })
  assert.equal(isFailureResult(ok), false)
})
