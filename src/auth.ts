/**
 * Pairing-token authentication for `/v1/*` routes.
 *
 * See draft-spec.md §6 (Authentication). The token never appears in logs,
 * error bodies, or URLs, and comparisons never take an early exit on the
 * raw token bytes.
 */

export type AuthResult = { ok: true } | { ok: false; code: "AUTH_REQUIRED" | "AUTH_INVALID" };

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

export function extractBearerToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = BEARER_PREFIX.exec(header.trim());
	if (!match) return null;
	const token = match[1].trim();
	return token.length > 0 ? token : null;
}

/**
 * Compares two secrets without leaking timing information through an early
 * exit. Both inputs are hashed to a fixed-length digest first so the
 * subsequent comparison never depends on the raw token's length, then
 * compared with the runtime's constant-time `timingSafeEqual`.
 */
async function constantTimeStringsEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(digestA, digestB);
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
	const token = extractBearerToken(request);
	if (!token) {
		return { ok: false, code: "AUTH_REQUIRED" };
	}

	const expected = env.APP_TOKEN;
	if (!expected) {
		// Misconfigured deployment: never treat a missing secret as "no auth required".
		return { ok: false, code: "AUTH_INVALID" };
	}

	const valid = await constantTimeStringsEqual(token, expected);
	if (!valid) {
		return { ok: false, code: "AUTH_INVALID" };
	}

	return { ok: true };
}
