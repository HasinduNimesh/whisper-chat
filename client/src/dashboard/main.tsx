import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { DashboardApp } from './App';
import '../index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <DashboardApp />
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
