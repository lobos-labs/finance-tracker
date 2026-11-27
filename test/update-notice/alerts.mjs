// src/main/alerts.ts, as src/main/background.ts uses it, without the database: no alerts, and notifications
// held back when the test says so (state.mjs held).
import { H } from './state.mjs'

export const HIDDEN_ARG = '--hidden'
export const checkAlerts = () => []
export const closeAction = () => 'close'
export const heldBack = () => H.held
export const loginItemWanted = () => null
export const notificationSettings = () => ({ keepRunning: true, pausedUntil: null, quietHours: null })
export const noteTransactionsSeen = () => {}
export const setNotificationSettings = () => ({})
