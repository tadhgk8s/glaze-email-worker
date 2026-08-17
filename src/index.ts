/**
 * Cloudflare Mail Worker — see draft-spec.md for the full technical spec.
 *
 * `fetch()` serves the private `/v1/*` JSON API (and public `/health`) that
 * the native Mac app talks to. `email()` receives inbound mail routed by
 * Cloudflare Email Routing and stores it in D1 via Drizzle.
 */
import { handleFetch } from "./api/router";
import { handleInboundEmail } from "./email/receive";

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		return handleFetch(request, env);
	},

	async email(message, env, _ctx): Promise<void> {
		await handleInboundEmail(message, env);
	},
} satisfies ExportedHandler<Env>;
