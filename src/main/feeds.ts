import * as db from './db'

const DAY = 86_400

/** Accounts that usually have activity but nothing lately: their bank feed is behind (some cards' feeds run about a month late). */
export function behindAccounts(nowTs: number): Array<{ id: string; name: string; last: number }> {
  const rows = db.all<{ id: string; name: string; last: number; n: number }>(
    `SELECT a.id, a.name, MAX(t.posted) AS last, SUM(CASE WHEN t.posted >= ? THEN 1 ELSE 0 END) AS n
     FROM accounts a JOIN transactions t ON t.account_id = a.id
     WHERE a.hidden = 0 AND t.pending = 0 GROUP BY a.id`,
    nowTs - 60 * DAY
  )
  // Quiet for a week, and four times longer than its usual gap between transactions.
  return rows.filter((r) => r.n >= 20 && nowTs - r.last > Math.max(7 * DAY, ((60 * DAY) / r.n) * 4))
}
