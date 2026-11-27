import * as db from './db'
import type { Trip } from '../shared/types'

// Trips: what's bought while away (meals abroad, a place to stay) is a one-off,
// not base spending, and isn't the habits the budget measures. Cards post a few
// days late, so a trip's purchases run through a few days past its last day.

const KEY = 'budget.trips'
/** Days after a trip's last day whose postings still belong to it. */
const POSTING_LAG = 3
const DAY = /^\d{4}-\d{2}-\d{2}$/

const dayStart = (day: string): number => db.dayStart(day)

export function listTrips(): Trip[] {
  try {
    const list = JSON.parse(db.getSetting(KEY) ?? '[]') as Trip[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** Adds a trip, or with an id changes one. */
export function saveTrip(t: { id?: string | null; name: string; from: string; to: string }): Trip {
  const name = String(t.name ?? '').trim()
  if (!name) throw new Error('A trip needs a name')
  if (!DAY.test(String(t.from)) || !DAY.test(String(t.to))) throw new Error('A trip needs a first and last day (YYYY-MM-DD)')
  if (t.to < t.from) throw new Error('The last day comes before the first')
  const trips = listTrips()
  if (t.id && !trips.some((x) => x.id === t.id)) throw new Error('No such trip')
  const trip: Trip = { id: t.id || `trip-${Date.now().toString(36)}`, name, from: t.from, to: t.to }
  db.setSetting(KEY, JSON.stringify([...trips.filter((x) => x.id !== trip.id), trip].sort((a, b) => a.from.localeCompare(b.from))))
  return trip
}

/** Puts a trip back exactly as a journal recorded it, under its old id (an undo). */
export function restoreTrip(trip: Trip): void {
  db.setSetting(KEY, JSON.stringify([...listTrips().filter((x) => x.id !== trip.id), trip].sort((a, b) => a.from.localeCompare(b.from))))
}

export function removeTrip(id: string): Trip {
  const trips = listTrips()
  const trip = trips.find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase())
  if (!trip) throw new Error('No such trip')
  db.setSetting(KEY, JSON.stringify(trips.filter((x) => x !== trip)))
  return trip
}

export interface TripWindow {
  trip: Trip
  /** unix seconds: the first day away, the day after the last, and the end of the posting lag */
  start: number
  back: number
  end: number
}

export function tripWindows(trips = listTrips()): TripWindow[] {
  return trips.map((trip) => {
    const back = dayStart(trip.to) + 86_400
    return { trip, start: dayStart(trip.from), back, end: back + POSTING_LAG * 86_400 }
  })
}

/** The trip a posting belongs to. */
export const tripAt = (windows: TripWindow[], posted: number): Trip | null => windows.find((w) => posted >= w.start && posted < w.end)?.trip ?? null

/** Days away between two unix times: the trips' own days, not their posting lag. */
export function daysAway(windows: TripWindow[], from: number, to: number): number {
  let s = 0
  for (const w of windows) s += Math.max(0, Math.min(to, w.back) - Math.max(from, w.start))
  return s / 86_400
}
