// test/m5.test.mjs — M5：eventSlim 落地即瘦身（trigger.eventSlim）
// 覆盖：MaidSlimmer.incrementalSlim（增量游标/replace 协议/幂等）、
//       MaidCompactionEngine.runPreCleanup（eventSlim 装配/审计/推进）、
//       compactIfNeeded 覆写接线（先 runPreCleanup 再委托官方）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MaidSlimmer } from '../src/slimmer.mjs'
import { MaidCompactionEngine } from '../src/engine.mjs'

const SLIM_CFG = { 'slim.thresholdChars': 100, 'slim.headChars': 20, 'slim.tailChars': 20 }

/** mock cordis ctx（MaidSlimmer/MaidCompactionEngine 构造所需最小面） */
function mockCtx(pruner) {
  const provided = {}
  const listeners = {}
  return {
    reflect: { provide: (name, value) => { provided[name] = value; return async () => {} } },
    get: (name) => {
      if (name === 'toolResultPruner') return pruner
      return undefined
    },
    on: (evt, cb) => { (listeners[evt] ??= []).push(cb); return () => {} },
    effect: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
}

/** fake session：surface.nodes / eventAt / append（记录调用，分配递增 seq） */
function fakeSession(events = []) {
  const log = [...events]
  let nextSeq = log.length ? Math.max(...log.map((e) => e.seq)) + 1 : 1
  const appended = []
  return {
    id: 'fake-session',
    surface: { nodes: log.map((e) => e.seq) },
    eventAt(seq) { return log.find((e) => e.seq === seq) },
    append(type, data, opts) {
      const ev = { seq: nextSeq++, type, data, ...opts }
      log.push(ev)
      appended.push(ev)
      return ev
    },
    get appendedCalls() { return appended },
  }
}

/** 构造一条 tool/result 表面事件（文本内容自定义） */
function resultEvent(seq, text, callId = 'c' + seq) {
  return {
    seq,
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      message: {
        role: 'tool',
        content: [{ type: 'tool-result', content: [{ type: 'text', text }] }],
        source: { callId },
      },
    },
  }
}

// —— MaidSlimmer.incrementalSlim ——
test('incrementalSlim：只处理 fromSeq 之后的新节点（游标语义）', () => {
  const ctx = mockCtx(undefined)
  const slimmer = new MaidSlimmer(ctx, SLIM_CFG)
  const sess = fakeSession([
    resultEvent(1, 'x'.repeat(500), 'old-big'),
    resultEvent(2, 'y'.repeat(500), 'new-big'),
    resultEvent(3, 'z'.repeat(50), 'small'),
  ])
  const rows = []
  const out = slimmer.incrementalSlim(sess, 1, (r) => rows.push(r))
  assert.equal(out.processed, 2, '游标后 2 个 tool/result 被检查')
  assert.equal(out.pruned, 1, '仅超预算者被瘦身')
  assert.ok(out.charsRemoved > 400, '字符回收发生')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].op, 'slim')
  assert.ok(rows[0].detail.includes('originalSeq":2'), '审计 detail 含原 seq')
})

test('incrementalSlim：replace 协议正确（prune 定价前置 + surfaceOp + 溯源）', () => {
  const ctx = mockCtx(undefined)
  const slimmer = new MaidSlimmer(ctx, SLIM_CFG)
  const sess = fakeSession([resultEvent(10, 'x'.repeat(500))])
  slimmer.incrementalSlim(sess, -1)
  const calls = sess.appendedCalls
  assert.equal(calls.length, 2, '定价事件 + replace 各一')
  assert.equal(calls[0].type, 'compaction/prune')
  assert.deepEqual(calls[0].data.shadowedSeqs, [10])
  assert.equal(calls[1].type, 'tool/result')
  assert.deepEqual(calls[1].surfaceOp, { op: 'replace', start: 10, end: 10 })
  assert.deepEqual(calls[1].sourceEventSeqs, [10])
  const text = calls[1].data.message.content[0].content[0].text
  assert.ok(text.length < 100, '替换文本已瘦身')
  // plain 文本走官方 head/tail 回退：头尾保留、中间截断（瘦身标记随官方 PRUNE_MARKER）
  assert.ok(text.startsWith('x'.repeat(20)) && text.endsWith('x'.repeat(20)), '头尾保留')
})

test('incrementalSlim：幂等——已瘦身节点二次运行 0 处置', () => {
  const ctx = mockCtx(undefined)
  const slimmer = new MaidSlimmer(ctx, SLIM_CFG)
  const sess = fakeSession([resultEvent(1, 'x'.repeat(500))])
  const first = slimmer.incrementalSlim(sess, -1)
  assert.equal(first.pruned, 1)
  const second = slimmer.incrementalSlim(sess, first.maxSeen)
  assert.equal(second.processed, 0)
  assert.equal(second.pruned, 0)
})

// —— MaidCompactionEngine.runPreCleanup ——
test('runPreCleanup：eventSlim 装配——审计落行 + 游标推进后不再处置', async () => {
  const slimmer = new MaidSlimmer(mockCtx(undefined), SLIM_CFG)
  const ctx = mockCtx(slimmer)
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false, 'trigger.eventSlim': true })
  const rows = []
  engine.maidAudit = { append: (r) => rows.push(r) }
  const sess = fakeSession([
    resultEvent(1, 'x'.repeat(50)),
    resultEvent(2, 'y'.repeat(500)),
  ])
  const agent = { session: sess }
  const out1 = await engine.runPreCleanup(agent)
  assert.equal(out1.eventSlim.pruned, 1, '超预算节点被瘦身')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].op, 'slim')
  assert.equal(rows[0].sessionId, 'fake-session')
  const rows2 = []
  engine.maidAudit = { append: (r) => rows2.push(r) }
  const out2 = await engine.runPreCleanup(agent)
  assert.equal(out2.eventSlim.pruned, 0)
  assert.equal(rows2.length, 0)
})

test('runPreCleanup：eventSlim=false 时不调 pruner；pruner 缺失时静默跳过', async () => {
  const pruner = { pruneSession() { throw new Error('不应被调用') }, incrementalSlim() { throw new Error('不应被调用') } }
  const ctx = mockCtx(pruner)
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false, 'trigger.eventSlim': false })
  const out = await engine.runPreCleanup({ session: fakeSession([resultEvent(1, 'x'.repeat(500))]) })
  assert.equal(out.eventSlim, null)
  const engine2 = new MaidCompactionEngine(mockCtx(undefined), { enabled: true, auto: false })
  const out2 = await engine2.runPreCleanup({ session: fakeSession([resultEvent(1, 'x'.repeat(500))]) })
  assert.equal(out2.eventSlim, null, 'fail-open')
})

// —— compactIfNeeded 覆写接线 ——
test('compactIfNeeded：先 runPreCleanup 再委托官方（无路由目标 → 官方返回 null）', async () => {
  const slimmer = new MaidSlimmer(mockCtx(undefined), SLIM_CFG)
  const ctx = mockCtx(slimmer)
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false, 'trigger.eventSlim': true })
  const rows = []
  engine.maidAudit = { append: (r) => rows.push(r) }
  const sess = fakeSession([resultEvent(1, 'x'.repeat(500))])
  sess.requestHeader = () => ({ config: undefined })
  const agent = { session: sess, options: {} }
  const res = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  assert.equal(res, null, '官方压力路径在无路由目标时返回 null')
  assert.ok(rows.some((r) => r.op === 'slim'), '前置清理已执行并审计')
})

test('MaidSlimmer 导出 incrementalSlim API；engine 覆写 compactIfNeeded', () => {
  assert.equal(typeof MaidSlimmer.prototype.incrementalSlim, 'function')
  assert.equal(typeof MaidCompactionEngine.prototype.runPreCleanup, 'function')
  assert.equal(typeof MaidCompactionEngine.prototype.compactIfNeeded, 'function')
})
