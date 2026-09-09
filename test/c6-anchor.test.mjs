// test/c6-anchor.test.mjs — C6 第一版：压缩后确定性锚点校验 + 记账货币口径
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extractAnchors, verifyAnchors, pinAnchorReport } from '../src/anchor.mjs'
import openMaidAudit from '../src/audit.mjs'

test('extractAnchors：抽取路径 / 引号字面量 / key=value / 全大写常量', () => {
  const text = '改 src/store.mjs 里的 WC_STALE_VERSION，配置 timeZone=Asia/Shanghai，保留「不要截断高权威条目」'
  const anchors = extractAnchors(text, { maxAnchors: 10 })
  assert.ok(anchors.includes('src/store.mjs'), '应抽到文件路径: ' + JSON.stringify(anchors))
  assert.ok(anchors.includes('WC_STALE_VERSION'), '应抽到常量')
  assert.ok(anchors.includes('timeZone=Asia/Shanghai'), '应抽到 key=value')
  assert.ok(anchors.some((a) => a.includes('不要截断高权威条目')), '应抽到引号字面量')
})

test('extractAnchors：maxAnchors / minAnchorLength / 去重生效', () => {
  const text = 'alpha.mjs beta.mjs gamma.mjs delta.mjs epsilon.mjs'
  assert.equal(extractAnchors(text, { maxAnchors: 3 }).length, 3)
  assert.deepEqual(extractAnchors('alpha.mjs alpha.mjs'), ['alpha.mjs'], '重复锚点只留一条')
  // 短锚点被 minAnchorLength 过滤
  assert.deepEqual(extractAnchors('a=b', { minAnchorLength: 6 }), [])
})

test('verifyAnchors：归一化比对（空白/大小写不判丢）', () => {
  const anchors = ['src/store.mjs', 'WC_STALE_VERSION']
  const summary = '本次改动在 SRC/Store.MJS 内，新增 wc_stale_version 语义'
  const r = verifyAnchors(anchors, summary)
  assert.equal(r.total, 2)
  assert.equal(r.hits.length, 2)
  assert.equal(r.ratio, 1)
})

test('verifyAnchors：缺失锚点进入 missed；无锚点时 ratio=null', () => {
  const r = verifyAnchors(['src/store.mjs', 'NOPE_CONST'], '只提到 src/store.mjs')
  assert.deepEqual(r.hits, ['src/store.mjs'])
  assert.deepEqual(r.missed, ['NOPE_CONST'])
  assert.equal(r.ratio, 0.5)
  assert.equal(verifyAnchors([], '任意').ratio, null)
})

test('pinAnchorReport：命中率 + 无锚点事实单独计数（没得验 ≠ 验过了没丢）', () => {
  const facts = [
    '[ACP user_explicit] 偏好用 src/audit.mjs 的 unit 口径',
    '[goal] 用户喜欢简洁的回答', // 无字面锚点
  ]
  const rep = pinAnchorReport(facts, '摘要里提到了 src/audit.mjs')
  assert.equal(rep.unverifiableFacts, 1)
  assert.equal(rep.total, 1)
  assert.equal(rep.hits.length, 1)
  assert.equal(rep.ratio, 1)
})

test('engine._verifyPinAnchors：落 audit op=pin（带 unit/producer），无锚点时也留痕', async () => {
  const { MaidCompactionEngine } = await import('../src/engine.mjs')
  const ctx = {
    reflect: { provide: () => async () => {} },
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false })
  const rows = []
  engine.maidAudit = { append: (row) => rows.push(row) }
  engine._verifyPinAnchors(
    ['[goal] 记住 src/anchor.mjs 与 PIN_BUDGET_CHARS'],
    { summary: [{ type: 'text', text: '## Files and Code\n- src/anchor.mjs 新增校验；PIN_BUDGET_CHARS 未变' }] },
    { session: { id: 'sess-1' } },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].op, 'pin')
  assert.equal(rows[0].unit, 'chars')
  assert.equal(rows[0].producer, 'dsh-context-maid')
  assert.equal(rows[0].sessionId, 'sess-1')
  assert.ok(rows[0].summary.includes('2/2 命中'), rows[0].summary)
  // 空 facts → 不落行（没东西可校验，不制造噪声）
  engine._verifyPinAnchors([], { summary: [{ type: 'text', text: 'x' }] }, { session: {} })
  assert.equal(rows.length, 1)
})

test('audit：unit / producer 列落库并可回读（v0.3.1 迁移）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'maid-audit-'))
  const audit = openMaidAudit(dir)
  t.after(() => { audit.close(); rmSync(dir, { recursive: true, force: true }) })
  audit.append({ op: 'slim', unit: 'chars', producer: 'dsh-context-maid', summary: 's' })
  audit.append({ op: 'fold', unit: 'estTokens', producer: 'dsh-context-maid', summary: 'f' })
  const rows = audit.recent(5)
  assert.equal(rows.length, 2)
  const byOp = Object.fromEntries(rows.map((r) => [r.op, r]))
  assert.equal(byOp.slim.unit, 'chars')
  assert.equal(byOp.fold.unit, 'estTokens')
  assert.equal(byOp.slim.producer, 'dsh-context-maid')
})
