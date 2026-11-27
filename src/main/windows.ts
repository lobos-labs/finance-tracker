// The days around an asset's purchase or sale in which its money moves, and how far apart the two sides of
// money moved between accounts post. A venture's result (ventures.ts) and the Personal classifier (lines.ts)
// both read them, so they live here and neither imports the other for them.

/** Money spent on a purchase day or up to this many days before is taken as buying the asset. */
export const PURCHASE_DAYS = 90
/** Money received on a sale day or up to this many days after is taken as the sale's proceeds. */
export const PROCEEDS_DAYS = 7
/** The two sides of money moved between accounts post up to this many days apart (as transfers are paired for net worth). */
export const LEG_DAYS = 5
/**
 * A cost paid for a venture, or by one, is paid back up to this many days after (waterfall spec addendum 1.11, I4 and
 * I5): money the other way of the same amount by then settles it, by a transfer for I5.
 */
export const REIMBURSE_DAYS = 30
