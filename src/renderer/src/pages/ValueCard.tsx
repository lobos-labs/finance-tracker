import type { ReactNode } from 'react'

/** A small labeled figure on a card. */
export function Fig({ label, value, tone }: { label: string; value: ReactNode; tone?: string }): ReactNode {
  return (
    <div>
      <div className="label-muted">{label}</div>
      <div className={`num ${tone ?? ''}`}>{value}</div>
    </div>
  )
}

/** The card the Net worth views share in their card layout: name, a line under it, the big amount, three figures. */
export function ValueCard({
  name,
  tag,
  sub,
  value,
  figs,
  footer,
  dim,
  onOpen
}: {
  name: string
  tag?: ReactNode
  sub?: string
  value: string
  figs: Array<{ label: string; value: ReactNode; tone?: string }>
  footer?: ReactNode
  dim?: boolean
  onOpen?: () => void
}): ReactNode {
  const body = (
    <>
      <div className="asset-card-top">
        <span className="asset-name truncate" title={name}>
          {name}
        </span>
        {tag}
      </div>
      <div className="label-muted truncate">{sub || ' '}</div>
      <div className="asset-value">{value}</div>
      <div className="asset-figs">
        {figs.map((f) => (
          <Fig key={f.label} {...f} />
        ))}
      </div>
      {footer && <div className="card-footer">{footer}</div>}
    </>
  )
  return onOpen ? (
    <button className={`asset-card ${dim ? 'sold' : ''}`} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className={`asset-card static ${dim ? 'sold' : ''}`}>{body}</div>
  )
}
