import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The decode worker is a module worker and must be built as one.
  //
  // Vite's default is `iife`, which flattens the worker and everything it
  // imports into one classic script. The libav.js runtime does not survive
  // that: built, it loads, answers nothing, and blocks its thread so hard that
  // even a timer set beside it never fires — no error, no frames, no way to
  // tell from the page that anything is wrong. In dev, where the modules are
  // served separately, the same code opens in under half a second.
  worker: { format: "es" },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  // `vite preview` serves the production build, which is the only way to
  // exercise the live path honestly: React StrictMode double-invokes effects
  // in dev, and two ring sessions on one tuner starve each other. It needs its
  // own proxy - `server.proxy` does not apply to it.
  preview: {
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
