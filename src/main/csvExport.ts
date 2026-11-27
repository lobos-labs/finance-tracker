import Papa from 'papaparse'
import type { Transaction } from '../shared/types'

// The transactions as a CSV for a spreadsheet. Text columns come from banks
// and from whoever paid the user, so a cell that starts like a formula gets a
// leading apostrophe: a spreadsheet then shows it as text instead of running it.

/** A text cell as a spreadsheet will read it. */
export const safeCell = (s: string): string => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s)

export type ExportRow = Transaction & { categoryName: string | null; bucketName: string | null }

/** One exported row; amounts and dates are the app's own, text columns are made safe. A split transaction's parts come as rows of their own, each with the transaction's id. */
export function exportRow(t: ExportRow): Record<string, string> {
  const posted = new Date(t.posted * 1000)
  return {
    date: Number.isNaN(posted.getTime()) ? '' : posted.toISOString().slice(0, 10),
    account: safeCell(t.accountName),
    merchant: safeCell(t.merchant ?? ''),
    description: safeCell(t.description),
    category: safeCell(t.categoryName ?? ''),
    bucket: safeCell(t.bucketName ?? 'Personal'),
    amount: (t.amountCents / 100).toFixed(2),
    pending: t.pending ? 'yes' : '',
    notes: safeCell(t.notes ?? ''),
    tags: safeCell((t.tags ?? []).join(', ')),
    id: safeCell(t.id)
  }
}

export const transactionsCsv = (rows: ExportRow[]): string => Papa.unparse(rows.map(exportRow))
