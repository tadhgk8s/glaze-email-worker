import { applyD1Migrations, env } from "cloudflare:test";

// Applies the committed Drizzle/D1 migrations to the isolated test database
// before any test runs. `TEST_MIGRATIONS` is populated by `readD1Migrations()`
// in vitest.config.mts and only exists in the test environment.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
