import * as db from './db'
import { THEMES, type ThemeChoice } from '../shared/types'

// Settings → Display's choice, as stored: System, Light or Dark. No Electron
// here (theme.ts applies it to the desktop's window), so a hosted ledger keeps
// the same setting for the web app to apply.

const KEY = 'display.theme'

export const themeChoice = (): ThemeChoice => {
  const v = db.getSetting(KEY)
  return (THEMES as readonly string[]).includes(v ?? '') ? (v as ThemeChoice) : 'system'
}

/** Saves the choice; throws on anything but a theme. */
export function saveThemeChoice(theme: ThemeChoice): void {
  if (!(THEMES as readonly string[]).includes(theme)) throw new Error('Unknown theme')
  db.setSetting(KEY, theme === 'system' ? null : theme)
}
