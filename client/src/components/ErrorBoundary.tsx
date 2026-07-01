import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render-time exceptions so a single bad input (e.g. a malformed
 * message from a hostile peer) can't white-screen the whole app. Renders a
 * minimal recovery UI instead of unmounting everything.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Never log message content; only the error itself for debugging.
    console.error('[ui] render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-wa-bg p-6 text-center">
        <p className="text-sm text-wa-secondary">Something went wrong.</p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-lg bg-wa-green px-4 py-2 text-sm font-semibold text-white transition hover:bg-wa-green-dark"
        >
          Reload
        </button>
      </div>
    );
  }
}
