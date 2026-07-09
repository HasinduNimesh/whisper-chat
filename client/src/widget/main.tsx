import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { connectBridge, parseBootParams } from './bridge';
import { useWidgetStore } from './useWidgetStore';
import { WidgetApp } from './WidgetApp';
import '../index.css';

const boot = parseBootParams(window.location.hash);

function Standalone({ message }: { message: string }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-wa-panel px-6 text-center text-sm text-wa-secondary">
      {message}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

if (!boot) {
  // Opened directly rather than through the embed script.
  root.render(<Standalone message="This page is the Whisper chat widget — embed it with embed.js (see docs/embedding.md)." />);
} else {
  const bridge = connectBridge(boot.parentOrigin, {
    onInit: (init) => {
      if (init.orgSlug !== boot.orgSlug) return; // config must match the URL the loader built
      void useWidgetStore.getState().configure(init, bridge.send);
    },
    onIdentify: (token) => {
      void useWidgetStore.getState().configure({ orgSlug: boot.orgSlug, token }, bridge.send);
    },
    onVisibility: (open) => useWidgetStore.getState().setVisible(open),
  });

  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <WidgetApp
          primaryColor={boot.primaryColor}
          onCloseRequest={() => bridge.send('close-request')}
        />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
