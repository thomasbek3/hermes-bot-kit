// The override's own error boundary (fix: live Transcript crash). A render or
// effect error anywhere in the override's panes stops here: the pane shows the
// error inline with "Try again" and "Turn override off" (the palette toggle,
// which brings stock Bot Mode back), and nothing propagates to Hermes's
// workspace or root boundary, so the window never goes down with us.

import * as React from 'react'

import { setEnabled } from './app'

export class OverrideBoundary extends React.Component<{ area: string; children?: any; onReset?: () => void; compact?: boolean }, { error: any }> {
  state = { error: null as any }

  static getDerivedStateFromError(error: any) {
    return { error }
  }

  componentDidCatch(error: any) {
    try {
      console.error(`[grokbot-override] ${this.props.area} crashed`, error)
    } catch {
      /* no console */
    }
  }

  render() {
    const error = this.state.error
    if (!error) return this.props.children ?? null
    const message = String(error?.message || error || 'Unknown error')
    const retry = () => {
      try {
        this.props.onReset?.()
      } finally {
        this.setState({ error: null })
      }
    }
    if (this.props.compact) {
      // A small surface (status-bar chip): a marker, not a full pane.
      return (
        <span data-gbo-root="" data-gbo-error={this.props.area} className="gbo-crashed-chip" role="alert" title={`Grokbot Override: ${message}`}>
          <button type="button" className="gbo-link-btn" onClick={retry}>
            Override error · retry
          </button>
        </span>
      )
    }
    return (
      <div data-gbo-root="" data-gbo-error={this.props.area} className="gbo-ws gbo-crashed" role="alert">
        <div className="gbo-center">
          <h2>Grokbot Override hit an error</h2>
          <p>{message}</p>
          <div className="gbo-card-actions">
            <button type="button" className="gbo-pill-btn is-primary" onClick={retry}>
              Try again
            </button>
            <button type="button" className="gbo-pill-btn" onClick={() => setEnabled(false)}>
              Turn override off
            </button>
          </div>
        </div>
      </div>
    )
  }
}
