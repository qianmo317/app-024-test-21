import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  test: {
    // e2e 由 Playwright 跑（npm run e2e），单元测试一条命令：npm test
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
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
});
