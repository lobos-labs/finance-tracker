import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { BENEFIT_KINDS, type InsuranceKind, type InsuranceView, type PremiumPeriod } from '../../../shared/types'
import { useApp } from '../App'
import { Icon } from '../Icon'
import { PageHeader } from '../PageHeader'
import { api, errorMessage, fmtDay, fmtMoneyRound } from '../lib'
import { EmptyCard, OpenFolderButton } from '../Empty'

type Policy = InsuranceView['policies'][number]

const money = (cents: number | null): string => (cents === null ? '—' : fmtMoneyRound(cents))
const PER: Record<PremiumPeriod, string> = { month: '/mo', quarter: '/qtr', 'half-year': '/6 mo', year: '/yr', 'one-time': ' once' }
const KIND: Record<InsuranceKind, string> = {
  auto: 'Auto',
  renters: 'Renters',
  home: 'Home',
  umbrella: 'Umbrella',
  health: 'Health',
  dental: 'Dental',
  vision: 'Vision',
  life: 'Life',
  disability: 'Disability',
  vehicle: 'Vehicle plan',
  device: 'Device',
  pet: 'Pet',
  travel: 'Travel',
  other: 'Other'
}
const premium = (p: Policy): string => (p.premiumCents === null ? '—' : `${fmtMoneyRound(p.premiumCents)}${p.premiumPeriod ? PER[p.premiumPeriod] : ''}`)

export default function Insurance(): ReactNode {
  const { tick, toast } = useApp()
  const [data, setData] = useState<InsuranceView | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    api.getInsurance().then(setData, (e) => toast(errorMessage(e), 'error'))
  }, [tick, toast])

  if (!data) return <PageHeader title="Insurance" />

  const active = data.policies.filter((p) => p.status === 'active')
  const ended = data.policies.filter((p) => p.status === 'ended')
  const paid = data.policies.reduce((t, p) => t + p.paidLastYearCents, 0)
  const plans = data.employer.plans
  const work = plans.reduce((t, p) => t + (p.yearlyCents ?? 0), 0)
  const rows = (list: Policy[]): ReactNode =>
    list.map((p) => (
      <Fragment key={p.id}>
        <button className={`asset-row insurance-row ${open === p.id ? 'open' : ''} ${p.status === 'ended' ? 'ended' : ''}`} aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
          <span className="truncate">
            {p.name}
            {p.carrier && <span className="muted"> · {p.carrier}</span>}
          </span>
          <span className="muted">{KIND[p.kind]}</span>
          <span className="num">{premium(p)}</span>
          <span className="num">{money(p.yearlyCents)}</span>
          <span className="num">{p.paidLastYearCents ? fmtMoneyRound(p.paidLastYearCents) : '—'}</span>
          <span className="num">{money(p.deductibleCents)}</span>
          <span className="mono small">{p.nextRenewal ? fmtDay(p.nextRenewal) : p.endDay ? `ends ${fmtDay(p.endDay)}` : '—'}</span>
        </button>
        {open === p.id && <PolicyDetail p={p} found={data.fileFound} />}
      </Fragment>
    ))
  const head = (
    <div className="asset-row insurance-row head" role="row">
      <span>Policy</span>
      <span>Kind</span>
      <span className="num">Premium</span>
      <span className="num">A year</span>
      <span className="num">Paid, 12 mo</span>
      <span className="num">Deductible</span>
      <span>Renews</span>
    </div>
  )

  return (
    <>
      <PageHeader title="Insurance" />
      <div className="page">
        <div className="stat-strip even">
          <div className="tile">
            <div className="label-muted">A year</div>
            <div className="tile-value">{data.totals.yearlyCents ? fmtMoneyRound(data.totals.yearlyCents) : '—'}</div>
            {work > 0 && <div className="tile-sub">{fmtMoneyRound(work)} through work</div>}
          </div>
          <div className="tile">
            <div className="label-muted">Paid, 12 months</div>
            <div className="tile-value">{paid ? fmtMoneyRound(paid) : '—'}</div>
          </div>
          <div className="tile">
            <div className="label-muted">Policies</div>
            <div className="tile-value">{data.totals.active}</div>
            {plans.length > 0 && <div className="tile-sub">+ {plans.length} through work</div>}
          </div>
          <div className="tile">
            <div className="label-muted">Next renewal</div>
            <div className="tile-value">{data.totals.nextRenewal ? fmtDay(data.totals.nextRenewal.day).replace(/, \d{4}$/, '') : '—'}</div>
            {data.totals.nextRenewal && <div className="tile-sub truncate">{data.totals.nextRenewal.name}</div>}
          </div>
        </div>

        {active.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Policies</h2>
            </div>
            <div className="asset-table" role="table">
              {head}
              {rows(active)}
            </div>
          </section>
        )}

        {plans.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Through work</h2>
              {data.employer.name && <span className="label-muted">{data.employer.name}</span>}
            </div>
            <div className="asset-table" role="table">
              <div className="insurance-work-row head" role="row">
                <span>Plan</span>
                <span>Kind</span>
                <span>Carrier</span>
                <span className="num">Per check</span>
                <span className="num">Employer</span>
                <span className="num">A year</span>
              </div>
              {plans.map((p) => (
                <div className="insurance-work-row" role="row" key={p.name}>
                  <span className="truncate">{p.name}</span>
                  <span className="muted">{BENEFIT_KINDS.find((k) => k.id === p.kind)?.label ?? p.kind}</span>
                  <span className="truncate muted">{p.carrier ?? '—'}</span>
                  <span className="num">{money(p.perCheckCents)}</span>
                  <span className="num muted">{money(p.employerPerCheckCents)}</span>
                  <span className="num">{money(p.yearlyCents)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {ended.length > 0 && (
          <section className="asset-group">
            <div className="asset-group-head">
              <h2>Ended</h2>
            </div>
            <div className="asset-table" role="table">
              {head}
              {rows(ended)}
            </div>
          </section>
        )}

        {data.policies.length === 0 && plans.length === 0 && (
          <EmptyCard label="No policies yet" style={{ marginTop: 30 }}>
            <OpenFolderButton sub="Insurance">Add policy</OpenFolderButton>
          </EmptyCard>
        )}
      </div>
    </>
  )
}

function PolicyDetail({ p, found }: { p: Policy; found: Record<string, boolean> }): ReactNode {
  const { toast } = useApp()
  const terms: Array<[string, string | null]> = [
    ['Policy', p.policyNumber],
    ['Started', p.startDay && fmtDay(p.startDay)],
    ['Term', p.termMonths ? `${p.termMonths} months` : null],
    ['Renews', p.nextRenewal && fmtDay(p.nextRenewal)],
    [p.status === 'ended' ? 'Ended' : 'Ends', p.endDay && fmtDay(p.endDay)],
    ['Last paid', p.lastPaid && `${fmtMoneyRound(p.lastPaid.cents)} · ${fmtDay(p.lastPaid.day)}`]
  ]
  const contact: Array<[string, string | null]> = [
    ['Claims', p.claimsPhone],
    ['Phone', p.phone],
    ['Website', p.website]
  ]
  return (
    <div className="tax-detail">
      <div className="tax-detail-cols">
        <div>
          <div className="label-muted">Covers</div>
          {p.covers && <div className="insurance-covers">{p.covers}</div>}
          {p.coverage.map((c, i) => (
            <div className="tax-kv" key={`${c.what}|${i}`}>
              <span>{c.what}</span>
              <span className="num">{c.limit}</span>
            </div>
          ))}
          {!p.covers && !p.coverage.length && <div className="small muted">—</div>}
        </div>
        <div>
          <div className="label-muted">Terms</div>
          {terms
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div className="tax-kv" key={k}>
                <span>{k}</span>
                <span className="num">{v}</span>
              </div>
            ))}
          {p.notes && <div className="small muted tax-sub">{p.notes}</div>}
        </div>
        <div>
          {contact.some(([, v]) => v) && (
            <>
              <div className="label-muted">Contact</div>
              {contact
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div className="tax-kv" key={k}>
                    <span>{k}</span>
                    <span className="num truncate">{v}</span>
                  </div>
                ))}
            </>
          )}
          {p.files.length > 0 && (
            <>
              <div className={`label-muted ${contact.some(([, v]) => v) ? 'tax-sub' : ''}`}>On file</div>
              {p.files.map((f, i) => {
                const on = found[f.file] ?? false
                return (
                  <button key={`${f.file}|${i}`} className={`tax-form ${on ? '' : 'gone'}`} title={f.file} disabled={!on} onClick={() => api.openInsuranceFile(f.file).catch((e) => toast(errorMessage(e), 'error'))}>
                    <Icon name="paperclip" size={12} />
                    <span className="truncate">{f.name}</span>
                  </button>
                )
              })}
            </>
          )}
          {p.source && <div className="small muted tax-sub">{p.source}</div>}
        </div>
      </div>
    </div>
  )
}
