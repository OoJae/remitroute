// Seed the minimal environment so shared/config.ts validates and loads when the
// modules under test import it. Kept hermetic: no real DB or secrets, just the
// shapes the zod schema requires. DATABASE_URL is the only hard-required field;
// SESSION_SECRET is set so the session round-trip tests have a stable secret.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/remitroute_test";
process.env.SESSION_SECRET ??= "test-session-secret-0000000000000000000000000000000000000000";
process.env.NODE_ENV ??= "test";
