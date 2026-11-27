// The shell at a phone's width (waterfall spec 2h): the sidebar gives way to a top bar, and its menu control opens the
// sidebar's entries over the page. styles.css draws it under the same width (@media (max-width: 700px)).

/** The width the sidebar gives way to the top bar at: the phone rules in styles.css use it too. */
export const NARROW = '(max-width: 700px)'

/**
 * What the open menu listens to and moves focus between: the document, the control that opens it, the panel it opens,
 * and what lies behind it (the top bar and the page), which can't be reached while it's open.
 */
export interface MenuParts {
  doc: Pick<Document, 'addEventListener' | 'removeEventListener'>
  control: { focus(): void; contains(node: Node | null): boolean } | null
  panel: { contains(node: Node | null): boolean; querySelector(selector: string): { focus(): void } | null } | null
  behind: Array<{ inert: boolean } | null>
}

/**
 * Opens the menu: focus moves to the page it marks as current (or its first entry), the top bar and the page behind it
 * go inert so Tab stays among its entries and nothing under the scrim can be pressed, and Escape or a tap anywhere
 * outside the panel and its control closes it. The returned cleanup, run as it closes, gives the top bar and the page
 * back and puts focus on the control. A tap is taken at its click, after the press has moved focus, so focus ends on
 * the control.
 */
export function openMenu(parts: MenuParts, close: () => void): () => void {
  const { doc, control, panel, behind } = parts
  for (const b of behind) if (b) b.inert = true
  ;(panel?.querySelector('[aria-current="page"]') ?? panel?.querySelector('button'))?.focus()
  const onKey = (e: Event): void => {
    if ((e as KeyboardEvent).key !== 'Escape') return
    e.preventDefault()
    close()
  }
  const onTap = (e: Event): void => {
    const at = e.target as Node | null
    if (panel?.contains(at) || control?.contains(at)) return
    close()
  }
  doc.addEventListener('keydown', onKey)
  doc.addEventListener('click', onTap)
  return () => {
    doc.removeEventListener('keydown', onKey)
    doc.removeEventListener('click', onTap)
    for (const b of behind) if (b) b.inert = false
    control?.focus()
  }
}
