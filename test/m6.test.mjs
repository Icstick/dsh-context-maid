// test/m6.test.mjs — M6：sweep 执行器（B7）
// 覆盖：stubToolResultNode（shadow-price 协议/stub 标记）、
//       engine runPreCleanup ② sweep 路径（启用开关/节流/审计）、
//       scanSweepCandidates 与 stub 端到端（处置后不再复发）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MaidCompactionEngine } from '../src/engine.mjs'
import { scanSweepCandidates } from '../src/sweeper.mjs'
import { stubToolResultNode } from '../src/slimmer.mjs'
import { MaidSlimmer } from '../src/slimmer.mjs'

function fakeSession(events = []) {
  const log = [...events]
  let nextSeq = log.length ? Math.max(...log.map((e) => e.seq)) + 1 : 1
  const appended = []
  const surface = { nodes: log.map((e) => e.seq) }
  return {
    id: 'fake-session',
    surface,
    eventAt(seq) { return log.find((e) => e.seq === seq) },
    append(type, data, opts) {
      const ev = { seq: nextSeq++, type, data, ...opts }
      log.push(ev)
      appended.push(ev)
      const op = opts?.surfaceOp
      if (op && op.op === 'replace') {
        // 位置语义：把 surface 上 [start..end]（按 seq 定位的位置段）替换为新节点
        const i0 = surface.nodes.indexOf(op.start)
        const i1 = surface.nodes.indexOf(op.end)
        if (i0 >= 0 && i1 >= i0) surface.nodes = [...surface.nodes.slice(0, i0), ev.seq, ...surface.nodes.slice(i1 + 1)]
      } else {
        surface.nodes = [...surface.nodes, ev.seq]
      }
      return ev
    },
    get appendedCalls() { return appended },
    get log() { return log },
  }
}

function callEvent(seq, id, name, args) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args ?? {}) }] } } }
}

function resultEvent(seq, callId, text) {
  return { seq, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text }] }], source: { callId } } } }
}

function mockCtx(pruner) {
  const provided = {}
  return {
    reflect: { provide: (name, value) => { provided[name] = value; return async () => {} } },
    get: (name) => (name === 'toolResultPruner' ? pruner : undefined),
    on: () => () => {},
    effect: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
}

/** 一段「重复读 + 失败重试」会话（M6 端到端夹具） */
function buildDupSession() {
  return fakeSession([
    callEvent(1, 'c1', 'read', { file_path: 'a.js' }),
    resultEvent(2, 'c1', 'content v1'),
    callEvent(3, 'c2', 'read', { file_path: 'a.js' }),
    resultEvent(4, 'c2', 'content v2'),
    callEvent(5, 'c3', 'build', {}),
    resultEvent(6, 'c3', 'error: build failed'),
    callEvent(7, 'c4', 'build', {}),
    resultEvent(8, 'c4', 'build ok'),
  ])
}

// —— stubToolResultNode ——
test('stubToolResultNode：整节点 stub + shadow-price 协议（marker 无原始内容）', () => {
  const sess = fakeSession([callEvent(1, 'c1', 'read', { file_path: 'a.js' }), resultEvent(2, 'c1', 'x'.repeat(9000))])
  const rows = []
  const out = stubToolResultNode(sess, 2, 'superseded-read', '同工具同参数前序结果已被后序取代', { onRow: (r) => rows.push(r) })
  assert.ok(out, '处置发生')
  assert.equal(out.charsBefore, 9000)
  const calls = sess.appendedCalls
  assert.equal(calls.length, 2)
  assert.equal(calls[0].type, 'compaction/prune')
  assert.deepEqual(calls[0].data.shadowedSeqs, [2])
  assert.equal(calls[1].type, 'tool/result')
  assert.deepEqual(calls[1].surfaceOp, { op: 'replace', start: 2, end: 2 })
  assert.deepEqual(calls[1].sourceEventSeqs, [2])
  const text = calls[1].data.message.content[0].content[0].text
  assert.ok(text.startsWith('[maid sweep: superseded-read'), 'stub 标记')
  assert.ok(!text.includes('xxxxx'), '原文不残留')
  assert.equal(calls[1].data.message.source.callId, 'c1', 'callId 配对保留')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].op, 'sweep')
})

test('stubToolResultNode：非 tool/result seq 返回 null（不动）', () => {
  const sess = fakeSession([callEvent(1, 'c1', 'read', { file_path: 'a.js' }), resultEvent(2, 'c1', 'ok')])
  assert.equal(stubToolResultNode(sess, 1, 'x', 'y'), null, 'assistant 节点不动')
  assert.equal(sess.appendedCalls.length, 0)
})

// —— scanSweepCandidates + stub 端到端 ——
test('端到端：扫描建议 → stub → 处置后不再复发（surface 折叠）', () => {
  const sess = buildDupSession()
  const c = scanSweepCandidates(sess)
  assert.deepEqual(c.map((x) => x.seq), [2, 6], '前序成功 + 失败重试被建议')
  const outs = []
  for (const cand of c) outs.push(stubToolResultNode(sess, cand.seq, cand.kind, cand.reason))
  // 真实 surface 语义：原 seq 位置被副本取代（fake 已实现 replace 折叠）
  assert.ok(!sess.surface.nodes.includes(2) && !sess.surface.nodes.includes(6), '原 seq 已离 surface')
  for (const o of outs) {
    const text = sess.log.find((e) => e.seq === o.replacementSeq)?.data?.message?.content?.[0]?.content?.[0]?.text ?? ''
    assert.ok(text.startsWith('[maid sweep'), '副本为 stub 标记')
  }
  // 副本 marker 被扫描器识别 → 不再建议
  const c2 = scanSweepCandidates(sess)
  assert.equal(c2.filter((x) => x.kind === 'superseded-read' || x.kind === 'failed-retry').length, 0, '已 stub 节点不再次建议')
})

// —— engine runPreCleanup ② sweep ——
test('runPreCleanup：sweep.enabled=true → 扫描处置 + 审计落行（op=sweep）', async () => {
  const slimmer = new MaidSlimmer(mockCtx(undefined), {})
  const engine = new MaidCompactionEngine(mockCtx(slimmer), { enabled: true, auto: false, 'sweep.enabled': true })
  const rows = []
  engine.maidAudit = { append: (r) => rows.push(r) }
  const sess = buildDupSession()
  const out = await engine.runPreCleanup({ session: sess })
  assert.equal(out.sweep.candidates, 2)
  assert.equal(out.sweep.swept, 2)
  const sweepRows = rows.filter((r) => r.op === 'sweep')
  assert.equal(sweepRows.length, 2)
  assert.ok(sweepRows.some((r) => r.detail.includes('superseded-read')))
  assert.ok(sweepRows.some((r) => r.detail.includes('failed-retry')))
  // 节流：紧接着第二次调用（surface 无新增、turns 未到 12）→ 不扫描
  const rows2 = []
  engine.maidAudit = { append: (r) => rows2.push(r) }
  const out2 = await engine.runPreCleanup({ session: sess })
  assert.equal(out2.sweep, null, '节流中（未达 12 step / 8 新节点）')
  assert.equal(rows2.length, 0)
})

test('runPreCleanup：sweep.enabled 缺省 false → 不扫描（sweep=null）', async () => {
  const slimmer = new MaidSlimmer(mockCtx(undefined), {})
  const engine = new MaidCompactionEngine(mockCtx(slimmer), { enabled: true, auto: false })
  const out = await engine.runPreCleanup({ session: buildDupSession() })
  assert.equal(out.sweep, null)
})
