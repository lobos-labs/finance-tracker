import type { ReactNode } from 'react'

/** Sticky top bar: serif title, an optional tag beside it, optional nav right after it, actions on the right. Also the window's drag handle. */
export function PageHeader({ title, tag, nav, children }: { title: string; tag?: ReactNode; nav?: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <header className="topbar">
      <h1>{title}</h1>
      {tag}
      {nav && <div className="topbar-nav">{nav}</div>}
      <div className="spacer" />
      {children}
    </header>
  )
}

/** The app mark: a copper frame around a rising bar chart. Also used for the window/shortcut icon. */
export function Logo({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <rect x="1" y="1" width="30" height="30" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 24.5h17" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="17" width="3.2" height="6" fill="currentColor" />
      <rect x="14.4" y="12.5" width="3.2" height="10.5" fill="currentColor" />
      <rect x="19.8" y="8" width="3.2" height="15" fill="currentColor" />
    </svg>
  )
}
