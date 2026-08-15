import '@luminaos/ui/tokens.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

const container = document.getElementById('root');
if (!container) {
  // A bare `throw new Error` is deliberate here, not a `packages/shared/errors`
  // `AppError` subclass: this is a client-side bootstrap invariant (the mount
  // point missing from `index.html` is a build/deploy-config bug, never
  // user-triggered), mirroring `apps/web/src/main.tsx`'s identical reasoning.
  throw new Error('Root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
