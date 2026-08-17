import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * Creates a Drizzle client scoped to a single request/handler invocation.
 *
 * Always call this with the `env` passed into the current `fetch`/`email`
 * handler. Never cache the returned client at module scope — doing so would
 * capture one invocation's environment and leak across isolates/requests.
 */
export function createDb(env: Env) {
	return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof createDb>;

export { schema };
