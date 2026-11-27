import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/source-serif-4'
import '@fontsource-variable/jetbrains-mono'
import App from './App'
import { UnlockPage } from './RecoveryCode'
import { APP_NAME } from '../../shared/app'
import './styles.css'

document.title = APP_NAME

interface Caught {
  error: string | null
}

/** A render error shows up as text with a way back, instead of a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, Caught> {
  state: Caught = { error: null }

  static getDerivedStateFromError(err: unknown): Caught {
    return { error: err instanceof Error ? (err.stack ?? err.message) : String(err) }
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    console.error(err instanceof Error ? err.message : String(err), info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div style={{ padding: '48px 40px', maxWidth: 900 }}>
        <h1 style={{ fontSize: 18, marginBottom: 16 }}>Error</h1>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5, marginBottom: 20, userSelect: 'text' }}>{this.state.error}</pre>
        <button className="btn" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}

// index.html#unlock is the window shown before the database opens (src/main/unlock.ts): the recovery code alone.
const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <ErrorBoundary>{location.hash === '#unlock' ? <UnlockPage /> : <App />}</ErrorBoundary>
  </StrictMode>
)

/** Takes the app out of the page (the web's trial-ended page takes the root in its place, web/main.ts). */
export const unmountApp = (): void => root.unmount()
