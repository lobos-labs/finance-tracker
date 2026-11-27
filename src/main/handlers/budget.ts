import { deleteScore, recordScore, setReminder } from '../credit'
import { adoptDebtPlan, getDebts } from '../debts'
import { addContribution, archiveGoal, deleteContribution, deleteGoal, goalViews, saveGoal } from '../goals'
import { homePlans } from '../homePlans'
import { can } from '../license'
import { CREDIT_BUREAUS, SCORE_MODELS, type CreditBureau, type GoalInput } from '../../shared/types'
import { changed, hosted, plus } from './context'

// Home's plans beside the waterfall, debts and their payoff order, savings goals,
// and the scores and reminder on the Credit page (free). The budget's targets,
// rollover, habits, tiers and one-off budget are Review's to set (tools.ts);
// Home's Left over and Saved show them (getHomePlans), on the desktop, the web
// and the phone.

export const budgetHandlers = {
  getDebts: hosted(() => getDebts()),
  // The debt plan's inputs a viewer kept in its own storage, sent once: they fill debt.plan only while nothing has set
  // it (debts.ts adoptDebtPlan), and views refresh only when they did.
  adoptDebtPlan: hosted((ctx, saved: { skip?: unknown; inputs?: unknown } | null) => {
    const r = adoptDebtPlan(saved)
    return r.adopted ? changed(ctx, r) : r
  }),
  // What Home's Left over and Saved drills read beside the waterfall: the targets, habits, one-off budget, goals (with
  // the plan that has them, as listGoals) and the debt plan's next target, all as they stand today (homePlans.ts).
  getHomePlans: hosted(() => homePlans({ goals: can('netWorth') })),

  listGoals: plus('netWorth', () => goalViews()),
  saveGoal: hosted((ctx, g: GoalInput) => changed(ctx, saveGoal(g))),
  archiveGoal: hosted((ctx, id: number, archived: boolean) => changed(ctx, archiveGoal(Number(id), !!archived))),
  deleteGoal: hosted((ctx, id: number) => changed(ctx, deleteGoal(Number(id)))),
  addGoalContribution: hosted((ctx, goalId: number, c: { day: string; cents: number; note?: string | null }) => changed(ctx, addContribution(Number(goalId), c ?? {}))),
  deleteGoalContribution: hosted((ctx, id: number) => changed(ctx, deleteContribution(Number(id)))),

  addCreditScore: hosted((ctx, s: { day: string; score: number; bureau: string; model: string; source?: string | null }) => {
    if (!CREDIT_BUREAUS.includes(s?.bureau as CreditBureau)) throw new Error(`Bureau must be one of ${CREDIT_BUREAUS.join(', ')}`)
    if (!SCORE_MODELS.includes(s?.model as (typeof SCORE_MODELS)[number])) throw new Error(`Model must be one of ${SCORE_MODELS.join(', ')}`)
    return changed(ctx, recordScore({ day: s.day, score: s.score, bureau: s.bureau, model: s.model, source: s.source }))
  }),
  deleteCreditScore: hosted((ctx, id: string) => changed(ctx, deleteScore(String(id)))),
  setCreditReminder: hosted((ctx, day: number | null) => {
    setReminder(day === null || day === undefined ? null : Number(day))
    ctx.calendarChanged()
    return changed(ctx, undefined)
  })
}
