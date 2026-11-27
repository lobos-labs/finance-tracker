// Investment returns from dated values and external cash flows.
//
// External flows are money put in or taken out: contributions, the employer
// match, rollovers and transfers. Dividends, interest, fees and trades inside
// an account are part of the return, not flows.
//
// A value is the end of its day and includes that day's flows. A flow on the
// first day of a period belongs to the period before it (it's already in the
// starting value).

export interface Dated {
  day: string
  cents: number
}

export interface SubPeriod {
  from: string
  to: string
  startCents: number
  endCents: number
  /** net external flows in (from, to] */
  flowCents: number
  /** Modified Dietz return; null when nothing was invested during the period */
  r: number | null
}

/** Values linked into sub-periods, and the flows between them. */
export interface Track {
  points: Dated[]
  flows: Dated[]
  subs: SubPeriod[]
}

export const dayNum = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000)
export const numDay = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10)
const gap = (from: string, to: string): number => dayNum(to) - dayNum(from)

/**
 * The Modified Dietz return over (from, to]: the gain over the average capital
 * invested, each flow weighted by the share of the period it was in. Starting
 * empty, the period starts with the first money in.
 */
export function dietz(startCents: number, endCents: number, flows: Dated[], from: string, to: string): number | null {
  if (startCents === 0 && flows.length) {
    const day = flows.reduce((d, f) => (f.day < d ? f.day : d), to)
    const opening = flows.filter((f) => f.day === day)
    if (day < to) return dietz(sum(opening), endCents, flows.filter((f) => f.day !== day), day, to)
  }
  const n = gap(from, to)
  if (n <= 0) return null
  let net = 0
  let weighted = 0
  for (const f of flows) {
    net += f.cents
    weighted += (f.cents * gap(f.day, to)) / n
  }
  const base = startCents + weighted
  return base > 0 ? (endCents - startCents - net) / base : null
}

/** Flows in (from, to]. */
export const flowsIn = (flows: Dated[], from: string, to: string): Dated[] => flows.filter((f) => f.day > from && f.day <= to)
const sum = (xs: Dated[]): number => xs.reduce((s, x) => s + x.cents, 0)

/** A feed's flows and flows recorded by hand; a recorded one the feed also reports (the same amount within `days`) counts once. */
export function withRecorded(feed: Dated[], recorded: Dated[], days = 3): Dated[] {
  const left = [...feed]
  const extra = recorded.filter((r) => {
    const i = left.findIndex((f) => f.cents === r.cents && Math.abs(dayNum(f.day) - dayNum(r.day)) <= days)
    if (i >= 0) left.splice(i, 1)
    return i < 0
  })
  return [...feed, ...extra]
}

/** Links values (one per day, any order) into sub-periods with their flows. */
export function track(points: Dated[], flows: Dated[]): Track {
  const sorted = [...points].sort((a, b) => (a.day < b.day ? -1 : 1))
  const subs: SubPeriod[] = []
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1], sorted[i]]
    const within = flowsIn(flows, a.day, b.day)
    subs.push({ from: a.day, to: b.day, startCents: a.cents, endCents: b.cents, flowCents: sum(within), r: dietz(a.cents, b.cents, within, a.day, b.day) })
  }
  return { points: sorted, flows: [...flows].sort((a, b) => (a.day < b.day ? -1 : 1)), subs }
}

/** A bank-synced balance can trail a flow by this many days. */
const SETTLE_DAYS = 2
/** A first value within this share of what was put in since means the account started empty. */
const EMPTY_START = 0.15
/** A sub-period return beyond this can only mean a missing flow. */
const IMPLAUSIBLE = 0.4
/** A balance under a dollar is an empty account. */
const EMPTY_CENTS = 100

export interface Balance extends Dated {
  /** from a bank sync, which can trail the day's transactions */
  synced?: boolean
}

/**
 * An account's track from the first day its flows are known (`since`):
 *  - values from the day before `since` on;
 *  - a synced balance within two days after a flow is left out (it may not show the flow yet);
 *  - a balance under a dollar is empty: the track starts over the last time the account was
 *    empty before holding money again, and one that's empty now ends the day it emptied;
 *  - when the first value is about what was put in since, the account starts empty the day before;
 *  - a sub-period whose return can only mean a missing flow (beyond ±40%, or a gain with
 *    nothing invested) starts the track over from its end.
 */
export function accountTrack(balances: Balance[], flows: Dated[], since: string): Track | null {
  const start = numDay(dayNum(since) - 1)
  const known = flows.filter((f) => f.day >= since)
  const unsettled = (day: string): boolean => known.some((f) => f.day <= day && gap(f.day, day) <= SETTLE_DAYS)
  const sorted = balances
    .filter((b) => b.day >= start && !(b.synced && unsettled(b.day)))
    .map((b) => ({ day: b.day, cents: b.cents < EMPTY_CENTS ? 0 : b.cents }))
    .sort((a, b) => (a.day < b.day ? -1 : 1))
  const lastHeld = sorted.findLastIndex((p) => p.cents > 0)
  if (lastHeld < 0) return null
  const points = sorted.slice(Math.max(0, sorted.findLastIndex((p, i) => i < lastHeld && p.cents === 0)), lastHeld + 2)
  const put = sum(flowsIn(known, start, points[0].day))
  if (points[0].day > start && put > 0 && Math.abs(points[0].cents - put) <= EMPTY_START * put) points.unshift({ day: start, cents: 0 })
  let t = track(points, known)
  for (let i = t.subs.length - 1; i >= 0; i--) {
    const s = t.subs[i]
    const gain = s.endCents - s.startCents - s.flowCents
    if (s.r === null ? Math.abs(gain) > Math.max(5000, 0.05 * Math.abs(s.endCents)) : Math.abs(s.r) > IMPLAUSIBLE) {
      t = track(
        t.points.filter((p) => p.day >= s.to),
        known
      )
      break
    }
  }
  return t.points.length > 1 ? t : null
}

const first = (t: Track): string => t.points[0].day
const last = (t: Track): string => t.points[t.points.length - 1].day
const subAt = (t: Track, day: string): SubPeriod | undefined => t.subs.find((s) => s.from < day && day <= s.to)
// A period with nothing invested had no return.
const growthOf = (s: SubPeriod): number => 1 + (s.r ?? 0)

/**
 * Growth of 1 from the first value to `day`, chaining the sub-periods; inside a
 * sub-period it compounds evenly by day. Null outside the values or after a
 * loss of everything.
 */
export function growth(t: Track, day: string): number | null {
  if (!t.points.length || day < first(t) || day > last(t)) return null
  let g = 1
  for (const s of t.subs) {
    if (s.from >= day) break
    const k = growthOf(s)
    if (k <= 0) return null
    g *= day >= s.to ? k : k ** (gap(s.from, day) / gap(s.from, s.to))
  }
  return g
}

/** Whether a day is within the values and on one, or inside a sub-period of at most `maxGap` days. */
export function placed(t: Track, day: string, maxGap = Infinity): boolean {
  if (!t.points.length || day < first(t) || day > last(t)) return false
  const s = subAt(t, day)
  return !s || s.to === day || gap(s.from, s.to) <= maxGap
}

/**
 * Time-weighted return over (from, to]. A start inside a sub-period longer
 * than `maxGap` days is too far from a known value to place, so gives null.
 */
export function twr(t: Track, from: string, to: string, maxGap = Infinity): number | null {
  if (!placed(t, from, maxGap)) return null
  const a = growth(t, from)
  const b = growth(t, to)
  return a === null || b === null ? null : b / a - 1
}

/** The value at the end of `day`: a known value, or the one before it plus the flows since and an even share of the period's gain. */
export function valueAt(t: Track, day: string): number | null {
  if (!t.points.length || day < first(t) || day > last(t)) return null
  if (day === first(t)) return t.points[0].cents
  const s = subAt(t, day)!
  const gain = s.endCents - s.startCents - s.flowCents
  return Math.round(s.startCents + sum(flowsIn(t.flows, s.from, day)) + (gain * gap(s.from, day)) / gap(s.from, s.to))
}

/**
 * The continuously compounded yearly rate at which the dated cash flows net to
 * zero (money in negative, money out and the ending value positive).
 */
function irrLog(cashflows: Dated[]): number | null {
  const flows = cashflows.filter((c) => c.cents !== 0)
  if (!flows.some((c) => c.cents > 0) || !flows.some((c) => c.cents < 0)) return null
  const t0 = Math.min(...flows.map((c) => dayNum(c.day)))
  const years = flows.map((c) => (dayNum(c.day) - t0) / 365)
  const npv = (x: number): number => flows.reduce((s, c, i) => s + c.cents * Math.exp(-x * years[i]), 0)
  let lo = -20
  let hi = 20
  let fLo = npv(lo)
  if (fLo === 0) return lo
  if (Math.sign(fLo) === Math.sign(npv(hi))) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const f = npv(mid)
    if (f === 0) return mid
    if (Math.sign(f) === Math.sign(fLo)) {
      lo = mid
      fLo = f
    } else hi = mid
  }
  return (lo + hi) / 2
}

/** XIRR: the yearly rate, compounded, that makes the dated cash flows net to zero. */
export function xirr(cashflows: Dated[]): number | null {
  const x = irrLog(cashflows)
  return x === null ? null : Math.exp(x) - 1
}

/** The money-weighted return of dated cash flows over their span (first money in to the end): XIRR compounded over the span instead of a year. */
export function irrOver(cashflows: Dated[]): number | null {
  const x = irrLog(cashflows)
  const days = cashflows.filter((c) => c.cents !== 0).map((c) => dayNum(c.day))
  return x === null ? null : Math.exp((x * (Math.max(...days) - Math.min(...days))) / 365) - 1
}

/** Cash flows of holding the track over (from, to]: the starting value in, flows in and out, the ending value out. */
export function cashflows(t: Track, from: string, to: string): Dated[] | null {
  const start = valueAt(t, from)
  const end = valueAt(t, to)
  if (start === null || end === null) return null
  return [{ day: from, cents: -start }, ...flowsIn(t.flows, from, to).map((f) => ({ day: f.day, cents: -f.cents })), { day: to, cents: end }]
}

/** Money-weighted return over (from, to], for the period (not yearly). */
export function mwr(t: Track, from: string, to: string): number | null {
  const cf = cashflows(t, from, to)
  return cf && irrOver(cf)
}

/** The value's change over (from, to] less the net flows in. */
export function gainOver(t: Track, from: string, to: string): number | null {
  const start = valueAt(t, from)
  const end = valueAt(t, to)
  return start === null || end === null ? null : end - start - sum(flowsIn(t.flows, from, to))
}

/** A return over `days` as a yearly rate, compounded, once the period is longer than a year. */
export const annualized = (r: number, days: number): number => (days > 366 ? (1 + r) ** (365 / days) - 1 : r)

/** Growth of 1 at each value. */
export const series = (t: Track): Array<{ day: string; g: number }> =>
  t.points.flatMap((p) => {
    const g = growth(t, p.day)
    return g === null ? [] : [{ day: p.day, g }]
  })

/**
 * Yearly volatility of a growth series sampled on uneven days: each log return
 * is scaled by its length in days, then a day's variance is taken to a year of
 * 365 days. Null with too few returns or too short a span.
 */
export function volatility(s: Array<{ day: string; g: number }>, minReturns = 20, minDays = 60): number | null {
  if (s.length < minReturns + 1 || gap(s[0].day, s[s.length - 1].day) < minDays) return null
  const rets = s.slice(1).map((p, i) => ({ l: Math.log(p.g / s[i].g), d: gap(s[i].day, p.day) }))
  const drift = rets.reduce((a, x) => a + x.l, 0) / rets.reduce((a, x) => a + x.d, 0)
  const perDay = rets.reduce((a, x) => a + (x.l - drift * x.d) ** 2 / x.d, 0) / (rets.length - 1)
  return Math.sqrt(perDay * 365)
}

/** The deepest fall from a high in a growth series (zero or negative). Null with too few values or too short a span. */
export function maxDrawdown(s: Array<{ day: string; g: number }>, minPoints = 20, minDays = 60): number | null {
  if (s.length < minPoints || gap(s[0].day, s[s.length - 1].day) < minDays) return null
  let peak = s[0].g
  let worst = 0
  for (const p of s) {
    peak = Math.max(peak, p.g)
    worst = Math.min(worst, p.g / peak - 1)
  }
  return worst
}

// ---------- several accounts together ----------

/** Each track's start-of-day capital and daily rate on each day it covers. */
interface Daily {
  t: Track
  start: number
  capital: number[]
  rate: number[]
}

function daily(t: Track): Daily {
  const start = dayNum(first(t))
  const n = dayNum(last(t)) - start
  const capital = new Array<number>(n + 1).fill(0)
  const rate = new Array<number>(n + 1).fill(0)
  for (const s of t.subs) {
    const a = dayNum(s.from) - start
    const b = dayNum(s.to) - start
    const k = growthOf(s)
    const r = k > 0 ? k ** (1 / (b - a)) - 1 : -1
    for (let i = a + 1; i <= b; i++) {
      capital[i] = valueAt(t, numDay(start + i - 1)) ?? 0
      rate[i] = r
    }
  }
  return { t, start, capital, rate }
}

/** Members' days of the window (from, to] that they cover, as [start, end]; null when they cover none of it. */
function clamp(t: Track, from: string, to: string): [string, string] | null {
  const a = from > first(t) ? from : first(t)
  const b = to < last(t) ? to : last(t)
  return a < b ? [a, b] : null
}

/**
 * Accounts held together. Each counts from its first value to its last; a day's
 * return is the members' daily returns weighted by their capital at the start
 * of the day.
 */
export class Composite {
  private members: Daily[]
  constructor(tracks: Track[]) {
    this.members = tracks.filter((t) => t.points.length > 1).map(daily)
  }

  get first(): string | null {
    return this.members.length ? this.members.map((m) => first(m.t)).sort()[0] : null
  }

  get last(): string | null {
    return this.members.length ? this.members.map((m) => last(m.t)).sort().reverse()[0] : null
  }

  /** Growth of 1 over (from, to]. */
  growth(from: string, to: string): number | null {
    let g = 1
    for (let d = dayNum(from) + 1; d <= dayNum(to); d++) {
      let num = 0
      let den = 0
      for (const m of this.members) {
        const i = d - m.start
        if (i <= 0 || i >= m.rate.length) continue
        num += m.capital[i] * m.rate[i]
        den += m.capital[i]
      }
      if (den > 0) g *= 1 + num / den
      if (g <= 0) return null
    }
    return g
  }

  twr(from: string, to: string): number | null {
    const g = this.growth(from, to)
    return g === null ? null : g - 1
  }

  /** A member joining after `from` brings its first value in; one ending before `to` takes its last value out. */
  mwr(from: string, to: string): number | null {
    const cf: Dated[] = []
    for (const m of this.members) {
      const span = clamp(m.t, from, to)
      const flows = span && cashflows(m.t, span[0], span[1])
      if (flows) cf.push(...flows)
    }
    return irrOver(cf)
  }

  gain(from: string, to: string): number {
    return this.members.reduce((s, m) => {
      const span = clamp(m.t, from, to)
      return s + (span ? (gainOver(m.t, span[0], span[1]) ?? 0) : 0)
    }, 0)
  }

  flows(from: string, to: string): number {
    return this.members.reduce((s, m) => {
      const span = clamp(m.t, from, to)
      return s + (span ? sum(flowsIn(m.t.flows, span[0], span[1])) : 0)
    }, 0)
  }

  /** Growth of 1 on the days members holding at least `share` of the capital have a known value. */
  series(from: string, to: string, share = 0.9): Array<{ day: string; g: number }> {
    const known = this.members.map((m) => new Set(m.t.points.map((p) => p.day)))
    const out: Array<{ day: string; g: number }> = [{ day: from, g: 1 }]
    let g = 1
    for (let d = dayNum(from) + 1; d <= dayNum(to); d++) {
      const day = numDay(d)
      let num = 0
      let den = 0
      let seen = 0
      this.members.forEach((m, k) => {
        const i = d - m.start
        if (i <= 0 || i >= m.rate.length) return
        num += m.capital[i] * m.rate[i]
        den += m.capital[i]
        if (known[k].has(day)) seen += m.capital[i]
      })
      if (den > 0) g *= 1 + num / den
      if (den > 0 && seen >= share * den) out.push({ day, g })
    }
    return out
  }
}
