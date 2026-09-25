// test/m8.test.mjs — M8（MAID-B16）：审计读取行的字段形状 + 真实播种闭环
//
// 背景：audit.recent() 返回的是 **SQLite 原生列名**（session_id / tokens_before / …），
// 而写入 API（append）与全部消费者（archiver.nextFoldDepth、commands status 的 foldDepth）
// 用的都是 **camelCase**。archiveIds 早先单独补过一次映射，其余的没补 ——
// 于是 r.sessionId 恒 undefined，B14 的「从审计库播种 foldDepth」在生产路径上**恒不生效**
// （每次进程重启都从 1 重来；/context-maid status 的 foldDepth 恒显示 0）。
//
// 为什么老测试没抓住：m3.test.mjs 的 B14 播种测试喂的是 { sessionId } 的 **mock 行**，
// 与真实行形状不一致。**本文件一律走真 SQLite 往返，不用 mock 行。**

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openMaidAudit } from '../src/audit.mjs'
import { nextFoldDepth } from '../src/archiver.mjs'

function freshDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'maid-m8-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

test('B16：recent() 的行与 append() 的入参同形（camelCase）', (t) => {
  const dir = freshDir(t)
  const audit = openMaidAudit(dir)
  audit.append({
    op: 'fold',
    sessionId: 'sess-x',
    range: '1:100',
    tokensBefore: 50000,
    tokensAfter: 30000,
    archiveIds: ['ev_1'],
    detail: JSON.stringify({ foldDepth: 2 }),
  })
  const [row] = audit.recent(10)
  assert.equal(row.sessionId, 'sess-x', 'sessionId 必须可直接读——消费者读的就是它')
  assert.equal(row.tokensBefore, 50000, 'tokensBefore 同上')
  assert.equal(row.tokensAfter, 30000, 'tokensAfter 同上')
  assert.deepEqual(row.archiveIds, ['ev_1'], 'archiveIds 早就有映射，这条是回归保护')
  assert.equal(row.op, 'fold')
  audit.close()
})

test('B16：nextFoldDepth 从**真**审计库播种，不从 1 重来', (t) => {
  const dir = freshDir(t)
  const audit = openMaidAudit(dir)
  const sid = 'sess-seed-' + Date.now()
  for (const d of [1, 2, 3]) {
    audit.append({ op: 'fold', sessionId: sid, detail: JSON.stringify({ note: 'x', foldDepth: d }) })
  }
  assert.equal(nextFoldDepth({ id: sid }, audit), 4, '真库里已有 3 层 → 下一次必须是 4')
  assert.equal(nextFoldDepth({ id: sid }, audit), 5, '同一进程内继续递增')
  audit.close()
})

test('B16：播种不受同库其他会话的历史深度影响', (t) => {
  const dir = freshDir(t)
  const audit = openMaidAudit(dir)
  const sid = 'sess-new-' + Date.now()
  audit.append({ op: 'fold', sessionId: 'sess-old-' + Date.now(), detail: JSON.stringify({ foldDepth: 9 }) })
  assert.equal(nextFoldDepth({ id: sid }, audit), 1, '别的会话折过 9 次不该算到本会话头上')
  audit.close()
})

test('B16：非 fold 行不参与播种', (t) => {
  const dir = freshDir(t)
  const audit = openMaidAudit(dir)
  const sid = 'sess-slim-' + Date.now()
  audit.append({ op: 'slim', sessionId: sid, detail: JSON.stringify({ foldDepth: 7 }) })
  assert.equal(nextFoldDepth({ id: sid }, audit), 1, '只有 op=fold 才算折叠层数')
  audit.close()
})
