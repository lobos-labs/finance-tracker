// The waterfall's rounding (spec 1.1), in integer arithmetic so every figure is the same on every machine: money
// is whole cents, a share or a run rate is rounded once, half away from zero, and a rate is tenths of a percent.

/** n / d rounded half away from zero, for whole numbers with d above 0. */
export function roundDiv(n: number, d: number): number {
  const q = Math.floor((2 * Math.abs(n) + d) / (2 * d))
  return n < 0 ? -q : q
}

/** A share of cents, in basis points (10000 is all of it), rounded half away from zero. */
export const shareCents = (cents: number, bp: number): number => roundDiv(cents * bp, 10000)

/** a as a percent of b, in tenths (64.8), with the sign of a / b; null when b is zero or less, as a rate has no base then. */
export function ratePct(a: number, b: number): number | null {
  if (b <= 0) return null
  const tenths = Math.floor((2000 * Math.abs(a) + b) / (2 * b))
  return (a < 0 ? -tenths : tenths) / 10
}
