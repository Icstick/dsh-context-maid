// src/audit.mjs — maid 策展审计（独立 SQLite，零依赖）。
// 每次策展（SLIM/SWEEP/FOLD/PIN）写一行；/context-maid status 与历史可查。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS maid_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  op TEXT NOT NULL,              -- slim | sweep | fold | pin | config | status
  session_id TEXT NOT NULL DEFAULT '',
  range TEXT NOT NULL DEFAULT '', -- start:end seqs（适用时）
  tokens_before INTEGER,
  tokens_after INTEGER,
  archive_ids TEXT NOT NULL DEFAULT '[]', -- 归档到 ACP 的条目 id
  summary TEXT NOT NULL DEFAULT '',       -- 摘要/说明（截断 500）
  detail TEXT NOT NULL DEFAULT '',
  -- 2026-09-09（P0-2 记账货币纪律）：本表数值的口径必须显式声明，绝不与宿主 token-meter 混算。
  unit TEXT NOT NULL DEFAULT '',          -- chars | estTokens（空 = 未声明）
  producer TEXT NOT NULL DEFAULT ''       -- 事件生产者（plugin id / 模块名）
);
CREATE INDEX IF NOT EXISTS idx_maid_audit_ts ON maid_audit (ts);
`

export function openMaidAudit(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'maid.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)
  // v0.3.1 迁移：unit / producer（列已存在时 ALTER 抛错，忽略即可）
  try { db.exec("ALTER TABLE maid_audit ADD COLUMN unit TEXT NOT NULL DEFAULT ''") } catch { /* 已迁移 */ }
  try { db.exec("ALTER TABLE maid_audit ADD COLUMN producer TEXT NOT NULL DEFAULT ''") } catch { /* 已迁移 */ }

  function append(row = {}) {
    try {
      db.prepare(`INSERT INTO maid_audit (ts, op, session_id, range, tokens_before, tokens_after, archive_ids, summary, detail, unit, producer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        Date.now(),
        String(row.op ?? ''),
        String(row.sessionId ?? ''),
        String(row.range ?? ''),
        row.tokensBefore ?? null,
        row.tokensAfter ?? null,
        JSON.stringify(row.archiveIds ?? []),
        String(row.summary ?? '').slice(0, 500),
        String(row.detail ?? '').slice(0, 500),
        String(row.unit ?? ''),
        String(row.producer ?? ''),
      )
    } catch { /* 审计失败不阻断策展 */ }
  }

  // MAID-B16（2026-09-25）：recent() 的行必须与 append() 的入参**同形**。
  //
  // 原写法只补了 archiveIds，其余多词列（session_id / tokens_before / tokens_after）
  // 仍是 SQLite 原生蛇形。而消费者读的是 camelCase ——
  //   archiver.mjs nextFoldDepth 读 r.sessionId、commands.mjs status 也读它 ——
  // 于是 r.sessionId 恒 undefined：**B14 的「从审计库播种 foldDepth」在生产路径上恒不生效**
  // （进程重启后每次都从 1 重来，status 的 foldDepth 恒显示 0）。
  // 老测试用 { sessionId } 的 mock 行，形状与真实行不一致，所以一直没抓住（见 test/m8.test.mjs）。
  //
  // 做法：**只增不删**。保留原生列（fold-verify 的测试照实断言过 rows[0].session_id），
  // 只把 camelCase 补齐。读侧容忍两种形状，写侧不因此改动。
  const toRow = (r) => ({
    ...r,
    sessionId: String(r.session_id ?? ''),
    tokensBefore: r.tokens_before ?? null,
    tokensAfter: r.tokens_after ?? null,
    archiveIds: JSON.parse(r.archive_ids),
  })

  function recent(limit = 20) {
    try {
      return db.prepare('SELECT * FROM maid_audit ORDER BY id DESC LIMIT ?').all(limit).map(toRow)
    } catch { return [] }
  }

  function stats(days = 7) {
    const since = Date.now() - days * 86400000
    try {
      return db.prepare('SELECT op, COUNT(*) n, SUM(tokens_before - tokens_after) saved FROM maid_audit WHERE ts >= ? GROUP BY op').all(since)
    } catch { return [] }
  }

  function close() { db.close() }

  return { db, append, recent, stats, close }
}

export default openMaidAudit
