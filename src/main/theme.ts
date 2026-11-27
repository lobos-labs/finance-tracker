import { nativeTheme, type BrowserWindow } from 'electron'
import { saveThemeChoice } from './themeSetting'
import type { ThemeChoice } from '../shared/types'

// Settings → Display: System, Light or Dark (stored by themeSetting.ts).
// nativeTheme.themeSource carries it to the page as prefers-color-scheme,
// which picks the palette in styles.css.

export { themeChoice } from './themeSetting'

/** The window follows a saved choice. */
export function applyTheme(theme: ThemeChoice): void {
  nativeTheme.themeSource = theme
}

export function setThemeChoice(theme: ThemeChoice): void {
  saveThemeChoice(theme)
  applyTheme(theme)
}

// The window behind the page and the caption buttons drawn over its top bar:
// styles.css's --ink-950 and --ink-300 in each theme.
const CHROME = {
  dark: { color: '#0a0a0b', symbolColor: '#9b9b9b' },
  light: { color: '#f3eee5', symbolColor: '#544b3f' }
}
export const OVERLAY_HEIGHT = 40

export const chrome = (): { color: string; symbolColor: string } => CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']

/** Keeps the window's background and caption buttons on the theme as it changes, by the setting or by the system. */
export function followTheme(win: BrowserWindow): void {
  const update = (): void => {
    if (win.isDestroyed()) return
    const c = chrome()
    win.setBackgroundColor(c.color)
    win.setTitleBarOverlay({ ...c, height: OVERLAY_HEIGHT })
  }
  nativeTheme.on('updated', update)
  win.once('closed', () => nativeTheme.off('updated', update))
}
