import { defineConfig } from "vitest/config";

// Node environment: these suites exercise pure, dependency-light shared logic
// (cadence math, signed sessions, schedule-param validation). No DOM, no DB, no
// network. setup.ts seeds the minimal env vars that shared/config.ts requires so
// importing the modules under test does not throw at load time.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
