import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['manifold-3d'], esbuildOptions: { target: 'es2022' } },
  worker: { format: 'es' },
});
