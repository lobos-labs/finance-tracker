import { performance } from 'node:perf_hooks'

// The spec's cost budgets (raw digests for 60 closed months under 150 ms, one changed month and its eleven followers
// under 500 ms, a drill's layout and lines) are milliseconds on one reference machine with nothing else running. Two
// things make the same work take different times there from one moment to the next. A processor can have two kinds of
// core, fast ones and efficient ones that take about 1.5 times as long,
// and Windows runs a test on either, moving it between them. And npm test runs every test file at once, beside other
// work on the machine. So a budget test times the engine's work against a fixed piece of work that runs none of the
// engine's code, in paired rounds: each round times the reference just before the work and just after it, and the
// round's ratio is the work's time over the two references' geometric mean. The result is the median of the rounds'
// ratios. Whichever core a round runs on and however busy the machine is then, both sides of it run alike, and one
// odd round doesn't decide it.
//
// A budget of B ms is a ratio of B / REFERENCE_MS, where REFERENCE_MS is what the reference takes on the fast cores
// with nothing else running: a ratio within it is the work within B ms on those cores. On the efficient cores the same
// ratio is about 1.5 times B.
//
// Each side is timed by the event loop's busy time: the main thread's milliseconds by the wall clock, less the time
// the loop waited (a check's pauses between steps). Windows counts a process's CPU time only every 15.6 ms, and that
// count includes the garbage collector's own threads, which go on collecting what the engine left behind while the
// reference runs. The reference allocates nothing, so neither the engine's heap nor its garbage can slow it, and a
// regression in what's timed (closing a month, classifying the books) can't slow the reference with it and cancel out.

/**
 * The event loop's busy milliseconds while an asynchronous `f` runs, to its end: the time by the wall clock less what
 * the loop waited, so its pauses aren't counted. (The loop's own busy time reads nothing until it has turned once,
 * and a test file whose imports load synchronously can run a test before then.)
 */
export async function busyOf(f: () => Promise<unknown> | unknown): Promise<number> {
  const at = performance.now()
  const was = performance.eventLoopUtilization()
  await f()
  return performance.now() - at - performance.eventLoopUtilization(was).idle
}

/** The busy milliseconds `f` takes: its time by the wall clock, since nothing waits in it. */
export function busyMs(f: () => unknown): number {
  const at = performance.now()
  f()
  return performance.now() - at
}

/** Runs `f` often enough to take `atLeast` busy ms, and gives one run's milliseconds. */
export function repeatedMs(f: () => unknown, atLeast = 100): number {
  let runs = 0
  let ms = 0
  while (ms < atLeast) {
    ms += busyMs(f)
    runs++
  }
  return ms / runs
}

/**
 * The reference's milliseconds on the reference machine's fast cores with nothing else running, as referenceMs times
 * it: the median of 20 timings was 21.3 to 21.5 ms pinned to a fast core, and
 * 32.3 to 32.9 ms on an efficient one. A budget of B ms is a ratio of B / REFERENCE_MS.
 */
export const REFERENCE_MS = 21.4

/** The reference's numbers, kept between runs, so a run makes no garbage. */
const numbers = new Float64Array(400_000)

/**
 * The reference: arithmetic in none of the engine's code. It fills 400,000 numbers from a fixed sequence, sorts them
 * and sums them, in an array it keeps, so it allocates nothing.
 */
export function referenceWork(): number {
  let x = 12_345
  for (let i = 0; i < numbers.length; i++) {
    x = (x * 1_103_515_245 + 12_345) & 0x7fffffff
    numbers[i] = x / 0x7fffffff
  }
  numbers.sort()
  let sum = 0
  for (let i = 0; i < numbers.length; i++) sum += numbers[i] * (i % 7)
  return sum
}

/** One run of the reference, in busy milliseconds, timed over as many runs as take 100 ms. */
export const referenceMs = (): number => repeatedMs(referenceWork)

/**
 * Paired rounds of `timed` (which gives the milliseconds it timed, so what it sets up beforehand isn't counted)
 * against the reference: each round runs `setup` (untimed), then the reference, `timed` and the reference again. The
 * median of the rounds' ratios of the work to the references' geometric mean, and each round's milliseconds,
 * work/reference.
 */
export async function paired(rounds: number, timed: (round: number) => Promise<number> | number, setup?: (round: number) => Promise<unknown> | unknown): Promise<{ ratio: number; seen: string }> {
  // A first run compiles the reference, so no round's reference pays for it.
  referenceWork()
  const ratios: number[] = []
  const seen: string[] = []
  for (let k = 0; k < rounds; k++) {
    await setup?.(k)
    const before = referenceMs()
    const w = await timed(k)
    const r = Math.sqrt(before * referenceMs())
    ratios.push(w / r)
    seen.push(`${w.toFixed(w < 10 ? 1 : 0)}/${r.toFixed(0)}`)
  }
  ratios.sort((a, b) => a - b)
  const mid = Math.floor(ratios.length / 2)
  return { ratio: ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2, seen: seen.join(', ') }
}

/** A budget in milliseconds as the ratio paired gives: what the work may take against the reference. */
export const budgetRatio = (ms: number): number => ms / REFERENCE_MS

/** What a paired result says against a budget: each round, the median ratio, the milliseconds it means on the fast cores, and the budget's ratio. */
export const within = (what: string, budget: number, r: { ratio: number; seen: string }): string =>
  `${what} against the reference, busy ms by round (work/reference): ${r.seen}; median ratio ${r.ratio.toFixed(r.ratio < 1 ? 3 : 2)}, about ${(r.ratio * REFERENCE_MS).toFixed(r.ratio * REFERENCE_MS < 10 ? 1 : 0)} ms on the fast cores with nothing else running; the budget, ${budget} ms, is a ratio of ${budgetRatio(budget).toFixed(2)}`
