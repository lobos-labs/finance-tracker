import { APP_NAME } from '../shared/app'

// The names the app gives what it makes in the user's Google account. A new
// connection's calendar and task list are named after the product; a
// connection made before the rename keeps its "Finance Tracker" calendar and
// list (found by their stored ids, whatever they're called) and goes on
// recognizing the tasks it made, which carry the old name as their mark. No
// Electron here, so the tests read it plain.

/** What the calendar, the task list and the tasks' mark were called before the rename. */
export const LEGACY_NAME = 'Finance Tracker'

/** What a calendar or task list made from now on is called. */
export const GOOGLE_NAME = APP_NAME

/** Ends the notes of every task the app makes from now on, so tasks the user adds to the list are left alone. */
export const TASK_MARK = APP_NAME

/** The marks of earlier builds under other names; none in this edition. */
const PLACEHOLDER_MARKS: string[] = []

const MARKS = [...new Set([TASK_MARK, LEGACY_NAME, ...PLACEHOLDER_MARKS])]

/** The mark a task's notes end with when the app made it (under either name); null for a task the user made. */
export function taskMarkOf(notes: unknown): string | null {
  const text = typeof notes === 'string' ? notes : ''
  return MARKS.find((m) => text.endsWith(m)) ?? null
}

/** Whether the app made the task. */
export const isAppTask = (notes: unknown): boolean => taskMarkOf(notes) !== null

/** The notes for a task: one the app made keeps the mark it has; a new one gets the new mark. */
export const taskNotes = (existing?: unknown): string => taskMarkOf(existing) ?? TASK_MARK

/** The calendar's name as stored when the app made it; one made before names were stored is the old one. */
export const calendarName = (stored: string | null | undefined): string => stored || LEGACY_NAME
