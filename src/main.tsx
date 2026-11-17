import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { setWasmLocator } from './core/geometry';
import './index.css';

setWasmLocator(() => wasmUrl);

const { default: App } = await import('./App');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
