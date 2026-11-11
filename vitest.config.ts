import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Many tests break things on purpose (a queue that is down, an invalid schedule, a failed
    // email) and the code logs those errors, as it should. Show that output only for a test that
    // fails, so a passing run is quiet and a real problem stands out.
    silent: 'passed-only',
    // Tests that simulate hours of evaluator runs take a few hundred milliseconds; that is expected.
    slowTestThreshold: 2000,
  },
});
