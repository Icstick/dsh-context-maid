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
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_maid_audit_ts ON maid_audit (ts);
`

export function openMaidAudit(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'maid.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)

  function append(row = {}) {
    try {
      db.prepare(`INSERT INTO maid_audit (ts, op, session_id, range, tokens_before, tokens_after, archive_ids, summary, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        Date.now(),
        String(row.op ?? ''),
        String(row.sessionId ?? ''),
        String(row.range ?? ''),
        row.tokensBefore ?? null,
        row.tokensAfter ?? null,
        JSON.stringify(row.archiveIds ?? []),
        String(row.summary ?? '').slice(0, 500),
        String(row.detail ?? '').slice(0, 500),
      )
    } catch { /* 审计失败不阻断策展 */ }
  }

  function recent(limit = 20) {
    try {
      return db.prepare('SELECT * FROM maid_audit ORDER BY id DESC LIMIT ?').all(limit)
        .map((r) => ({ ...r, archiveIds: JSON.parse(r.archive_ids) }))
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
