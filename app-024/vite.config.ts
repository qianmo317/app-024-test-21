import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5104,
  },
  test: {
    // 单元测试范围；tests/e2e 归 Playwright（npm run e2e），不交给 vitest
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
  },
});
