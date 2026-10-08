import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Without this, an uncaught render error (e.g. getVault() throwing because
 * VITE_MODE=chain is set but VITE_CONTRACT_ADDRESS is empty) unmounts the
 * entire React tree and the app renders blank — the "tabs don't work" bug.
 * store.ts's getVault() has also been hardened to never throw in that
 * case, but this stays as the backstop for any other render-time error.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card error-card">
          <h2>Something broke</h2>
          <pre className="code-block">
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
