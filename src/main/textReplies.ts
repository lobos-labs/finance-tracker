import * as db from './db'
import { snapshotBefore } from './journal'
import { setLowDays } from './overdraw'
import { renewalSeries, renewalSeriesKey, setRenewalMark } from './renewals'
import { cancelLine } from '../shared/cancelSteps'
import type { TextReply } from '../shared/types'

// What a reply to a text alert does, in the books of the person who replied
// (finance-server/src/sms finds them, the text it answers and their books:
// their own, or the household's they joined). Each is a write like any other,
// journaled ("text_reply" in journal.ts, origin "text:<who replied>", a
// partner also as `member`) so Undo can put it back:
// - HOW, on a renewal reminder: the answer is how to cancel it (the company's
//   own page or steps, src/shared/cancelSteps.ts), and the series is marked
//   asked-to-cancel so its next reminder doesn't come. The mark is the books'
//   (both members' reminders stop, and Spendable reads it).
// - KEEP, on a renewal reminder: no more reminders for that series, for either.
// - DONE, on an overdraw alert: no more low-balance alerts today, for the one
//   who replied.
// The reply word isn't CANCEL: carriers read a bare CANCEL as STOP. STOP and
// START aren't here: they turn the person's text channel off and on
// (ledgerAlerts.ts) and are the carrier's rules, not something to undo.

/** The replies each kind of text offers, in the words of its last line. */
export const REPLIES: Record<'renewal' | 'overdraw', { replies: TextReply[]; line: string }> = {
  renewal: { replies: ['HOW', 'KEEP'], line: 'Reply HOW for how to cancel, KEEP to stop these.' },
  overdraw: { replies: ['DONE'], line: "Reply DONE once it's handled." }
}

const kindOfKey = (key: string): keyof typeof REPLIES | null => (key.startsWith('renewal:') ? 'renewal' : key.startsWith('overdraw:') ? 'overdraw' : null)

/** The journal's origin for a text reply: this, then the person who replied (as connected apps' "mcp:<member>"). */
export const TEXT_ORIGIN = 'text'

/**
 * The answer texted back, and the journal entry that undoes the reply; `member`: a partner who replied (null,
 * the owner), whose own low-balance days DONE sets; `by`: the person who replied (the origin "text:<by>"). A
 * reply the text didn't offer throws.
 */
export function answerTextReply(key: string, reply: TextReply, now = db.now(), member: string | null = null, by?: string): { text: string; changeId: number } {
  const kind = kindOfKey(key)
  if (!kind || !REPLIES[kind].replies.includes(reply)) throw new Error(`${String(reply)} doesn't answer that text`)
  const input = { key, reply, ...(member ? { member } : {}) }
  return db.inTransaction(() => {
    const before = snapshotBefore('text_reply', input)
    let text: string
    if (kind === 'overdraw') {
      setLowDays({ done: db.dayKey(now) }, member)
      text = 'Got it. Nothing more on this today.'
    } else {
      const seriesKey = renewalSeriesKey(key)
      if (!seriesKey) throw new Error('That text names no subscription')
      const name = renewalSeries().find((s) => s.key === seriesKey)?.name ?? seriesKey.split('|')[0]
      if (reply === 'KEEP') {
        setRenewalMark(seriesKey, { keep: true })
        text = `No more renewal reminders for ${name}.`
      } else {
        setRenewalMark(seriesKey, { cancelAt: now })
        text = cancelLine(name)
      }
    }
    const changeId = db.addChange({ turnId: null, origin: by ? `${TEXT_ORIGIN}:${by}` : TEXT_ORIGIN, tool: 'text_reply', input, before, after: null })
    return { text, changeId }
  })
}
