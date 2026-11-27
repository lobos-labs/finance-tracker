// US yearly limits, by tax year, in cents. Each year lists every field. A
// value the IRS or SSA has not announced yet carries the previous year's
// figure forward with `provisional: true`, and the UI shows it as "est.".
// Update this table each autumn when the notices come out.

export interface Limit {
  cents: number
  /** carried forward from an earlier year, not announced for this one */
  provisional: boolean
}

export interface YearLimits {
  year: number
  /** 401(k), 403(b), 457 and TSP elective deferral, §402(g)(1) */
  deferral: Limit
  /** age-50 catch-up, §414(v)(2)(B)(i) */
  catchUp50: Limit
  /** ages 60–63 catch-up, §414(v)(2)(E)(i); before 2025 it is the age-50 amount */
  catchUp60to63: Limit
  /** all contributions to a defined-contribution plan, §415(c)(1)(A) */
  dcTotal: Limit
  /** IRA, §219(b)(5)(A) */
  ira: Limit
  /** IRA age-50 catch-up, §219(b)(5)(B) */
  iraCatchUp: Limit
  hsaSelf: Limit
  hsaFamily: Limit
  /** HSA age-55 catch-up, §223(b)(3): statutory, not indexed */
  hsaCatchUp: Limit
  hdhpMinDeductibleSelf: Limit
  hdhpMinDeductibleFamily: Limit
  hdhpOutOfPocketSelf: Limit
  hdhpOutOfPocketFamily: Limit
  /** health FSA salary reduction, and the carryover it allows */
  fsa: Limit
  fsaCarryover: Limit
  /** Social Security (OASDI) taxable wage base */
  ssWageBase: Limit
}

export type LimitField = Exclude<keyof YearLimits, 'year'>

export const LIMIT_FIELDS: LimitField[] = [
  'deferral',
  'catchUp50',
  'catchUp60to63',
  'dcTotal',
  'ira',
  'iraCatchUp',
  'hsaSelf',
  'hsaFamily',
  'hsaCatchUp',
  'hdhpMinDeductibleSelf',
  'hdhpMinDeductibleFamily',
  'hdhpOutOfPocketSelf',
  'hdhpOutOfPocketFamily',
  'fsa',
  'fsaCarryover',
  'ssWageBase'
]

/** An announced figure, in dollars. */
const set = (dollars: number): Limit => ({ cents: Math.round(dollars * 100), provisional: false })
/** Not announced for the year: the last known figure, in dollars. */
const carried = (dollars: number): Limit => ({ cents: Math.round(dollars * 100), provisional: true })

// Sources, by year:
// 2023: Notice 2022-55 (401(k), IRA); Rev. Proc. 2022-24 (HSA/HDHP); Rev. Proc. 2022-38 (FSA); SSA (wage base).
// 2024: Notice 2023-75; Rev. Proc. 2023-23; Rev. Proc. 2023-34; SSA.
// 2025: Notice 2024-80 (first year of the 60–63 catch-up); Rev. Proc. 2024-25; Rev. Proc. 2024-40; SSA.
// 2026: Notice 2025-67 (IR-2025-111, Nov 13 2025); Rev. Proc. 2025-19; Rev. Proc. 2025-32; SSA (cbb.html).
// 2027: Rev. Proc. 2026-24 (HSA/HDHP, May 29 2026); SSA Oct 14 2026 COLA release (wage base $192,300).
//       The 401(k), IRA and FSA figures for 2027 were not announced as of Oct 20 2026 and carry 2026 forward.
export const LIMITS: YearLimits[] = [
  {
    year: 2023,
    deferral: set(22_500),
    catchUp50: set(7_500),
    catchUp60to63: set(7_500),
    dcTotal: set(66_000),
    ira: set(6_500),
    iraCatchUp: set(1_000),
    hsaSelf: set(3_850),
    hsaFamily: set(7_750),
    hsaCatchUp: set(1_000),
    hdhpMinDeductibleSelf: set(1_500),
    hdhpMinDeductibleFamily: set(3_000),
    hdhpOutOfPocketSelf: set(7_500),
    hdhpOutOfPocketFamily: set(15_000),
    fsa: set(3_050),
    fsaCarryover: set(610),
    ssWageBase: set(160_200)
  },
  {
    year: 2024,
    deferral: set(23_000),
    catchUp50: set(7_500),
    catchUp60to63: set(7_500),
    dcTotal: set(69_000),
    ira: set(7_000),
    iraCatchUp: set(1_000),
    hsaSelf: set(4_150),
    hsaFamily: set(8_300),
    hsaCatchUp: set(1_000),
    hdhpMinDeductibleSelf: set(1_600),
    hdhpMinDeductibleFamily: set(3_200),
    hdhpOutOfPocketSelf: set(8_050),
    hdhpOutOfPocketFamily: set(16_100),
    fsa: set(3_200),
    fsaCarryover: set(640),
    ssWageBase: set(168_600)
  },
  {
    year: 2025,
    deferral: set(23_500),
    catchUp50: set(7_500),
    catchUp60to63: set(11_250),
    dcTotal: set(70_000),
    ira: set(7_000),
    iraCatchUp: set(1_000),
    hsaSelf: set(4_300),
    hsaFamily: set(8_550),
    hsaCatchUp: set(1_000),
    hdhpMinDeductibleSelf: set(1_650),
    hdhpMinDeductibleFamily: set(3_300),
    hdhpOutOfPocketSelf: set(8_300),
    hdhpOutOfPocketFamily: set(16_600),
    fsa: set(3_300),
    fsaCarryover: set(660),
    ssWageBase: set(176_100)
  },
  {
    year: 2026,
    deferral: set(24_500),
    catchUp50: set(8_000),
    catchUp60to63: set(11_250),
    dcTotal: set(72_000),
    ira: set(7_500),
    iraCatchUp: set(1_100),
    hsaSelf: set(4_400),
    hsaFamily: set(8_750),
    hsaCatchUp: set(1_000),
    hdhpMinDeductibleSelf: set(1_700),
    hdhpMinDeductibleFamily: set(3_400),
    hdhpOutOfPocketSelf: set(8_500),
    hdhpOutOfPocketFamily: set(17_000),
    fsa: set(3_400),
    fsaCarryover: set(680),
    ssWageBase: set(184_500)
  },
  {
    year: 2027,
    deferral: carried(24_500),
    catchUp50: carried(8_000),
    catchUp60to63: carried(11_250),
    dcTotal: carried(72_000),
    ira: carried(7_500),
    iraCatchUp: carried(1_100),
    hsaSelf: set(4_500),
    hsaFamily: set(9_000),
    hsaCatchUp: set(1_000),
    hdhpMinDeductibleSelf: set(1_750),
    hdhpMinDeductibleFamily: set(3_500),
    hdhpOutOfPocketSelf: set(8_700),
    hdhpOutOfPocketFamily: set(17_400),
    fsa: carried(3_400),
    fsaCarryover: carried(680),
    ssWageBase: set(192_300)
  }
]

const asProvisional = (l: YearLimits, year: number): YearLimits => ({
  ...Object.fromEntries(LIMIT_FIELDS.map((f) => [f, { ...l[f], provisional: true }])),
  year
} as YearLimits)

/**
 * The limits for a year. A year past the table gets the latest year's values,
 * every one provisional; a year before it gets the earliest, likewise.
 */
export function limitsFor(year: number): YearLimits {
  const exact = LIMITS.find((l) => l.year === year)
  if (exact) return exact
  const earlier = LIMITS.filter((l) => l.year < year).at(-1)
  return asProvisional(earlier ?? LIMITS[0], year)
}
