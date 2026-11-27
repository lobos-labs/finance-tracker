import { leftOverPlans } from './budget'
import { nextDebt } from './debts'
import { goalViews } from './goals'
import type { HomePlans } from '../shared/types'

// What Home's Left over and Saved drills read beside the waterfall (waterfall spec 1.5 and 1.6), in one call: the
// plans Review keeps, as they stand today. Each category's target and rollover, the habits and the commitments made
// for them, the one-off budget and the trips not over yet come from the budget (budget.ts); the goals as goals.ts
// shows them; and the debt
// the payoff plan pays extra on first (debts.ts). None of it is the span's, so Home asks once a data change. Goals
// come with the plan that has them (Net worth, investments and goals); without it the list is empty.

export function homePlans(o: { goals: boolean } = { goals: true }): HomePlans {
  return {
    ...leftOverPlans(),
    goals: o.goals
      ? goalViews()
          .filter((g) => g.archivedAt === null)
          .map((g) => ({ id: g.id, name: g.name, savedCents: g.savedCents, targetCents: g.targetCents }))
      : [],
    nextDebt: nextDebt()
  }
}
