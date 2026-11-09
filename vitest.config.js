import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
    setupFiles: ['./tests/setup.js'],
    env: {
      NODE_ENV: 'test',
      STORAGE_BACKEND: 'local'
    }
  }
});
