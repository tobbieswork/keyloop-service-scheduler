/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser talks to one origin. In development and preview, `/api/...` is forwarded to the
// scheduler backend with the `/api` prefix removed, so the backend needs no CORS configuration.
const backend = process.env['BACKEND_URL'] ?? 'http://localhost:3000';
const proxy = {
  '/api': {
    target: backend,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
  },
});
