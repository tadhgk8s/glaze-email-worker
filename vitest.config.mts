import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
	const migrationsPath = path.join(__dirname, "drizzle");
	const migrations = await readD1Migrations(migrationsPath);

	return {
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
			poolOptions: {
				workers: {
					wrangler: { configPath: "./wrangler.jsonc" },
					miniflare: {
						// Test-only binding so the setup file can apply migrations
						// against the isolated in-memory D1 database per test file.
						bindings: { TEST_MIGRATIONS: migrations },
					},
				},
			},
		},
	};
});
