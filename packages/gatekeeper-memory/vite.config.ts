import { defineConfig } from 'vite-plus'
import { vitestTask } from '@gadgets/scripts/vitest-task'

/**
 * Vite+ settings for this package. The test task runs the plain Node vitest suite
 * (see vitest.config.ts); no app build, no workerd pool in v1.
 */
export default defineConfig({
  run: {
    tasks: {
      test: vitestTask(['vitest run']),
    },
  },
})
