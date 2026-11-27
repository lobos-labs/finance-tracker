import * as db from '../db'
import { alertPrefs, setAlertPrefs } from '../ledgerAlerts'
import type { AlertPrefsPatch } from '../../shared/types'
import { hosted } from './context'

// The hosted ledger's alert preferences (ledgerAlerts.ts): each kind on or
// off, its channels (push, text, email) and thresholds, amounts in the text,
// quiet hours and a pause. The web and the phone ask at sign-up and in
// Settings; the desktop's own notifications keep theirs (ipc-alerts.ts). On a
// ledger shared with a partner, each member reads and sets their own.

export const alertHandlers = {
  getAlertPrefs: hosted((ctx) => alertPrefs(db.now(), ctx.member ?? null)),
  setAlertPrefs: hosted((ctx, patch: AlertPrefsPatch) => setAlertPrefs(patch, db.now(), ctx.member ?? null))
}
