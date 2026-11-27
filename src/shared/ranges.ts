// Spending ranges are sent as values at every 5th percentile (0, 5, ..., 100).

export const QUANTILES = Array.from({ length: 21 }, (_, i) => i * 5)

/** The value at a percentile (a multiple of 5). */
export const at = (q: number[], percent: number): number => q[Math.round(percent / 5)]
