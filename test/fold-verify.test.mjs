// test/fold-verify.test.mjs — 折叠后「不可丢约束」校验（确定性、零 LLM）
//
// 背景（2026-09-25）：压缩的失败点不在摘要质量，而在约束与结构的丢失。
// C6 v1（anchor.mjs）只做了「PIN 事实的字面锚点是否出现在摘要里」这半边；
// 本文件守护补上的另一半：
//   ① 折叠前的「不可丢约束清单摘要」——PIN 集合 + 每条约束的稳定标识（sha256，非 LLM）
//   ② 注入是否真的发生过——PIN 预算截断掉的事实**从未发给模型**，
//      绝不能被算成「模型弄丢了」（这是旧口径的真实误判）
//   ③ 三态结论 ok / partial / lost 落审计，默认只告警不阻塞
import { test } from 'node:test'
import assert from 'node:assert/strict'

const MOD = '../src/fold-verify.mjs'

// —— ① 稳定标识 ——

test('constraintKind：按 PIN 前缀确定性分类（不靠 LLM）', async () => {
  const { constraintKind } = await import(MOD)
  assert.equal(constraintKind('[ACP user_explicit] 偏好 pnpm'), 'acp:user_explicit')
  assert.equal(constraintKind('[ACP user_correction] 改用 pnpm'), 'acp:user_correction')
  assert.equal(constraintKind('[ACP system_policy] 只读'), 'acp:system_policy')
  assert.equal(constraintKind('[goal] 跑通全量测试'), 'goal')
  assert.equal(constraintKind('[user-pinned] 必须用 pnpm'), 'user-pinned')
  assert.equal(constraintKind('裸文本没有前缀'), 'other')
})

test('constraintId：同样约束同 id；空白/大小写不影响；不同约束不同 id', async () => {
  const { constraintId } = await import(MOD)
  const a = constraintId('acp:user_explicit', '[ACP user_explicit] 偏好 pnpm')
  const b = constraintId('acp:user_explicit', '[ACP  user_explicit]   偏好   PNPM ')
  assert.equal(a, b, '归一化后同一约束必须同 id')
  assert.match(a, /^[0-9a-f]{10}$/, 'id 是 10 位十六进制（确定性摘要）')
  assert.notEqual(a, constraintId('acp:user_explicit', '[ACP user_explicit] 偏好 yarn'))
  assert.notEqual(a, constraintId('goal', '[ACP user_explicit] 偏好 pnpm'), '同文本不同 kind → 不同 id')
})

// —— ② 折叠前清单摘要（含注入记账）——

test('buildConstraintManifest：清单摘要含总/已注入/未注入 + 已注入约束的稳定标识', async () => {
  const { buildConstraintManifest } = await import(MOD)
  const facts = [
    '[ACP user_explicit] 必须用 pnpm，改 src/engine.mjs',
    '[goal] 跑通全量测试',
  ]
  const m = buildConstraintManifest(facts, { injected: 1, budget: 1800 })
  assert.equal(m.v, 1)
  assert.equal(m.total, 2)
  assert.equal(m.injected, 1)
  assert.equal(m.omitted, 1, '预算截断掉的事实必须单列，不能混进「已注入」')
  assert.equal(m.budget, 1800)
  assert.equal(m.ids.length, 1, '稳定标识只覆盖真正注入的约束')
  assert.equal(m.ids[0].kind, 'acp:user_explicit')
  assert.match(m.ids[0].id, /^[0-9a-f]{10}$/)
})

test('buildConstraintManifest：injected 缺省 = 全部（向后兼容旧调用方）', async () => {
  const { buildConstraintManifest } = await import(MOD)
  const m = buildConstraintManifest(['[goal] a', '[goal] b'])
  assert.equal(m.injected, 2)
  assert.equal(m.omitted, 0)
  assert.equal(m.budget, null)
})

test('buildConstraintManifest：锚点带归属，能回答「丢的是哪条约束」', async () => {
  const { buildConstraintManifest } = await import(MOD)
  const m = buildConstraintManifest(['[ACP user_explicit] 改 src/anchor.mjs'])
  assert.ok(m.anchors.includes('src/anchor.mjs'), JSON.stringify(m.anchors))
  assert.equal(m.anchorOwners['src/anchor.mjs'], m.ids[0].id, '锚点必须能追回它属于哪条约束')
})

// —— ③ 三态结论 ——

test('verifyFoldConstraints：全命中 → ok', async () => {
  const { buildConstraintManifest, verifyFoldConstraints } = await import(MOD)
  const m = buildConstraintManifest(['[ACP user_explicit] 改 src/anchor.mjs 与 WC_STALE_VERSION'])
  const v = verifyFoldConstraints(m, '## Files' + String.fromCharCode(10) + '- src/anchor.mjs：新增校验；WC_STALE_VERSION 未变')
  assert.equal(v.status, 'ok')
  assert.equal(v.checked, 2)
  assert.equal(v.hits, 2)
  assert.deepEqual(v.lostIds, [])
})

test('verifyFoldConstraints：部分命中 → partial，并列出具体丢了的约束 id', async () => {
  const { buildConstraintManifest, verifyFoldConstraints } = await import(MOD)
  const m = buildConstraintManifest(['[ACP user_explicit] 改 src/anchor.mjs 与 WC_STALE_VERSION'])
  const v = verifyFoldConstraints(m, '## Files' + String.fromCharCode(10) + '- src/anchor.mjs 有改动')
  assert.equal(v.status, 'partial')
  assert.equal(v.checked, 2)
  assert.equal(v.hits, 1)
  assert.deepEqual(v.missed, ['WC_STALE_VERSION'])
  assert.deepEqual(v.lostIds, [m.anchorOwners['WC_STALE_VERSION']], '丢的必须落到约束 id 上')
})

test('verifyFoldConstraints：全丢 → lost', async () => {
  const { buildConstraintManifest, verifyFoldConstraints } = await import(MOD)
  const m = buildConstraintManifest(['[ACP user_explicit] 改 src/anchor.mjs'])
  const v = verifyFoldConstraints(m, '摘要里什么都没提')
  assert.equal(v.status, 'lost')
  assert.equal(v.hits, 0)
  assert.equal(v.lostIds.length, 1)
})

test('verifyFoldConstraints：注入了但抽不出锚点 → unverifiable（没得验 ≠ 验过了没丢）', async () => {
  const { buildConstraintManifest, verifyFoldConstraints } = await import(MOD)
  const m = buildConstraintManifest(['[goal] 用户喜欢简洁的回答'])
  const v = verifyFoldConstraints(m, '随便什么摘要')
  assert.equal(v.status, 'unverifiable')
  assert.equal(v.checked, 0)
  assert.equal(v.hits, 0)
})

test('verifyFoldConstraints：一条都没注入 → not-injected（路径断开，不是模型丢的）', async () => {
  const { buildConstraintManifest, verifyFoldConstraints } = await import(MOD)
  const m = buildConstraintManifest(['[ACP user_explicit] 改 src/anchor.mjs'], { injected: 0 })
  const v = verifyFoldConstraints(m, '摘要里就是没提')
  assert.equal(v.status, 'not-injected')
  assert.notEqual(v.status, 'lost', '「没发出去」与「发出去被丢了」必须分开')
  assert.equal(v.checked, 0)
})

test('verifyFoldConstraints：空清单 → idle（无约束可校验，不制造噪声）', async () => {
  const { buildConstraintManifest, verifyFoldConstraints } = await import(MOD)
  const v = verifyFoldConstraints(buildConstraintManifest([]), '任意摘要')
  assert.equal(v.status, 'idle')
  assert.equal(v.total, 0)
})

// —— ④ 审计分布（/context-maid status 用）——

test('summarizeFoldVerify：统计近 N 次 ok/partial/lost 分布', async () => {
  const { summarizeFoldVerify } = await import(MOD)
  const row = (status, missed, lostIds) => ({
    op: 'pin',
    detail: JSON.stringify({ status, missed: missed || [], lostIds: lostIds || [], hits: status === 'ok' ? 2 : 0, total: 2 }),
  })
  const h = summarizeFoldVerify([row('ok'), row('partial'), row('partial'), row('lost', ['A'], ['deadbeef00']), { op: 'fold', detail: '{}' }])
  assert.equal(h.runs, 4, '只统计 op=pin 且能解析出 status 的行')
  assert.equal(h.ok, 1)
  assert.equal(h.partial, 2)
  assert.equal(h.lost, 1)
  const p = summarizeFoldVerify([{ op: 'pin', detail: '{}' }])
  assert.equal(p.runs, 0)
  assert.equal(p.unstated, 1, '旧行（C6 v1 无 status）单独计数，不冒充 ok')
})

// —— ⑤ 接线：引擎真的传了「注入记账」+ 默认只告警 ——

test('引擎接线：PIN 预算截断掉的事实不计入「丢失」（旧口径的真实误判）', async () => {
  const { MaidCompactionEngine } = await import('../src/engine.mjs')
  const ctx = {
    reflect: { provide: () => async () => {} },
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false })
  const rows = []
  engine.maidAudit = { append: (r) => rows.push(r) }
  const facts = ['[ACP user_explicit] 改 src/anchor.mjs', '[goal] 跑通全量测试']
  engine._verifyPinAnchors(
    facts,
    { summary: [{ type: 'text', text: '只在 src/anchor.mjs 改了东西' }] },
    { session: { id: 'sess-fv' } },
    { injected: 1, omitted: 1, budget: 1800 },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].op, 'pin')
  const detail = JSON.parse(rows[0].detail)
  assert.equal(detail.status, 'ok', '被截断的那条不算丢失，也不该把本次判成 partial')
  assert.equal(detail.checked, 1, '校验分母只含真正注入的约束')
  assert.equal(detail.injectedFacts, 1)
  assert.equal(detail.notInjectedFacts, 1, '未注入数必须可见，否则「我们自己丢了」会被记成「模型丢了」')
})

test('引擎接线：全丢时 warn，但绝不抛（默认只告警不阻塞）', async () => {
  const { MaidCompactionEngine } = await import('../src/engine.mjs')
  const warns = []
  const ctx = {
    reflect: { provide: () => async () => {} },
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn: (m) => warns.push(m), error() {} },
  }
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false })
  const rows = []
  engine.maidAudit = { append: (r) => rows.push(r) }
  assert.doesNotThrow(() => {
    engine._verifyPinAnchors(
      ['[ACP user_explicit] 改 src/anchor.mjs'],
      { summary: [{ type: 'text', text: '完全无关的摘要' }] },
      { session: { id: 's' } },
      { injected: 1, omitted: 0 },
    )
  })
  assert.equal(JSON.parse(rows[0].detail).status, 'lost')
  assert.ok(warns.some((w) => w.includes('丢失') || w.includes('lost')), JSON.stringify(warns))
})

test('引擎接线：fold.verify.enabled=false → 不校验、不落行', async () => {
  const { MaidCompactionEngine } = await import('../src/engine.mjs')
  const ctx = {
    reflect: { provide: () => async () => {} },
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false, 'fold.verify.enabled': false })
  const rows = []
  engine.maidAudit = { append: (r) => rows.push(r) }
  engine._verifyPinAnchors(
    ['[ACP user_explicit] 改 src/anchor.mjs'],
    { summary: [{ type: 'text', text: '无关' }] },
    { session: { id: 's' } },
    { injected: 1, omitted: 0 },
  )
  assert.equal(rows.length, 0, '关掉后不落行')
})

test('引擎接线：summarize 真的把注入记账传给了校验（不是只有单元函数）', async () => {
  const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic')
  const { MaidCompactionEngine } = await import('../src/engine.mjs')
  const orig = BasicCompactionEngine.prototype.summarize
  // 桩掉官方回落路径：本测试只关心 maid 的接线，不跑真会话
  BasicCompactionEngine.prototype.summarize = async () => ({ summary: [{ type: 'text', text: '摘要提到 src/anchor.mjs' }] })
  try {
    const ctx = {
      reflect: { provide: () => async () => {} },
      get: () => undefined,
      on: () => () => {},
      logger: { info() {}, warn() {}, error() {} },
    }
    // 4 条各 ~500 字符 → 超过 PIN 预算 1800，末尾必然被截断
    const long = (i) => '[user-pinned] ' + '约'.repeat(480) + ' src/anchor.mjs #' + i
    const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false, 'pin.extra': [long(1), long(2), long(3), long(4)] })
    const rows = []
    engine.maidAudit = { append: (r) => rows.push(r) }
    await engine.summarize({ messages: [] }, { session: { id: 'sess-wire', cwd: '' } }, undefined)
    assert.equal(rows.length, 1, 'summarize 必须触发一次校验留痕')
    const detail = JSON.parse(rows[0].detail)
    assert.ok(detail.injectedFacts >= 1, '有注入的事实')
    assert.ok(detail.notInjectedFacts >= 1, 'PIN 预算截断必须被记账：' + JSON.stringify(detail))
    assert.equal(detail.collectedFacts, 4)
    assert.ok(['ok', 'partial', 'lost', 'unverifiable', 'not-injected'].includes(detail.status))
    assert.ok(detail.manifestIds.length >= 1, '落盘的清单摘要带稳定标识')
  } finally {
    BasicCompactionEngine.prototype.summarize = orig
  }
})

// —— ⑥ 配置面：自持键 + 铁律 3（不进官方透传）——

test('Config：fold.verify.enabled 默认 true，且不进官方透传（铁律 3）', async () => {
  const mod = await import('../src/index.mjs')
  assert.equal(mod.Config()['fold.verify.enabled'], true, '默认开（默认只告警）')
  const { toOfficialConfig } = await import('../src/engine.mjs')
  const off = toOfficialConfig({ 'fold.verify.enabled': true, 'trigger.userRatio': 0.59, 'fold.retainRatio': 0.2 })
  assert.equal(off['fold.verify.enabled'], undefined, 'maid 自持键不得进官方 config')
  assert.equal(off.thresholdRatio, 0.59, '阈值语义不动')
  assert.equal(off.retainRatio, 0.2)
})

test('端到端：审计库回读——大清单下 detail 仍是可解析 JSON（截断不许写出半截 JSON）', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const openMaidAudit = (await import('../src/audit.mjs')).default
  const { MaidCompactionEngine } = await import('../src/engine.mjs')
  const { summarizeFoldVerify } = await import('../src/fold-verify.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'maid-fv-'))
  const audit = openMaidAudit(dir)
  t.after(() => { audit.close(); rmSync(dir, { recursive: true, force: true }) })
  const ctx = {
    reflect: { provide: () => async () => {} },
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const engine = new MaidCompactionEngine(ctx, { enabled: true, auto: false })
  engine.maidAudit = audit
  // 16 条带字面锚点的事实（全部注入）→ detail 字段必然超过审计的 500 字符上限
  const facts = []
  for (let i = 0; i < 16; i++) facts.push('[ACP user_explicit] 改 src/mod' + i + '.mjs 与 CONST_' + i)
  const summary = '## Files' + String.fromCharCode(10) + '- src/mod1.mjs 与 CONST_1 已改'
  engine._verifyPinAnchors(facts, { summary: [{ type: 'text', text: summary }] }, { session: { id: 'sess-e2e' } })
  const rows = audit.recent(5)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].op, 'pin')
  // 审计 recent() 回的是 SQLite 原生列名（session_id），不是 camelCase——照实断言
  assert.equal(rows[0].session_id, 'sess-e2e')
  assert.ok(rows[0].detail.length <= 500, '审计列上限 500')
  const detail = JSON.parse(rows[0].detail)
  assert.equal(detail.status, 'partial')
  assert.equal(detail.collectedFacts, 16)
  assert.equal(detail.manifestIdCount, 16)
  assert.equal(detail.checked, 5, '锚点数受 maxAnchors 上限约束')
  assert.equal(detail.hits, 2)
  const fv = summarizeFoldVerify(rows, { maxRuns: 20 })
  assert.equal(fv.runs, 1)
  assert.equal(fv.partial, 1)
  assert.ok(fv.lostIds.length > 0, '丢的是哪条约束必须能从审计库回读')
})

test('端到端：/context-maid status 真的渲染出「折叠后约束校验」三态分布', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const openMaidAudit = (await import('../src/audit.mjs')).default
  const { registerMaidCommands } = await import('../src/commands.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'maid-status-'))
  const audit = openMaidAudit(dir)
  t.after(() => { audit.close(); rmSync(dir, { recursive: true, force: true }) })
  audit.append({ op: 'pin', unit: 'chars', producer: 'dsh-context-maid', summary: 's1', detail: JSON.stringify({ status: 'ok', hits: 2, total: 2 }) })
  audit.append({ op: 'pin', unit: 'chars', producer: 'dsh-context-maid', summary: 's2', detail: JSON.stringify({ status: 'partial', hits: 1, total: 2, lostIds: ['abc1234567'] }) })
  audit.append({ op: 'pin', unit: 'chars', producer: 'dsh-context-maid', summary: 's3', detail: JSON.stringify({ status: 'lost', hits: 0, total: 2 }) })
  let handler = null
  const ctx = {
    get: (n) => (n === 'commands' ? { register: (def) => { handler = def.handler } } : undefined),
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  registerMaidCommands(ctx, {
    config: { 'trigger.userRatio': 0.59, 'trigger.eventSlim': true, 'sweep.enabled': false, enabled: true },
    audit,
    getCompaction: () => undefined,
  })
  assert.equal(typeof handler, 'function', '命令应已注册（commands 服务在线）')
  const out = await handler({ rawInput: 'status', agent: { session: { id: 'sess-status' } } })
  assert.equal(out.kind, 'success')
  assert.ok(out.text.includes('折叠后约束校验（近 3 次）: ok 1 · partial 1 · lost 1'), out.text)
  assert.ok(out.text.includes('把约束完全丢了'), 'lost 必须有告警行')
})
