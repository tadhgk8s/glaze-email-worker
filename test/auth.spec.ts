import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authenticate, extractBearerToken } from "../src/auth";

describe("extractBearerToken", () => {
	it("reads a bearer token from the Authorization header", () => {
		const request = new Request("https://example.com", { headers: { Authorization: "Bearer abc123" } });
		expect(extractBearerToken(request)).toBe("abc123");
	});

	it("returns null when the header is missing", () => {
		const request = new Request("https://example.com");
		expect(extractBearerToken(request)).toBeNull();
	});

	it("returns null for non-bearer schemes", () => {
		const request = new Request("https://example.com", { headers: { Authorization: "Basic abc123" } });
		expect(extractBearerToken(request)).toBeNull();
	});
});

describe("authenticate", () => {
	it("returns AUTH_REQUIRED when the token is missing", async () => {
		const request = new Request("https://example.com");
		expect(await authenticate(request, env)).toEqual({ ok: false, code: "AUTH_REQUIRED" });
	});

	it("returns AUTH_INVALID for an incorrect token", async () => {
		const request = new Request("https://example.com", { headers: { Authorization: "Bearer definitely-wrong" } });
		expect(await authenticate(request, env)).toEqual({ ok: false, code: "AUTH_INVALID" });
	});

	it("accepts the configured pairing token", async () => {
		const request = new Request("https://example.com", { headers: { Authorization: `Bearer ${env.APP_TOKEN}` } });
		expect(await authenticate(request, env)).toEqual({ ok: true });
	});

	it("never accepts the token via the URL", async () => {
		const request = new Request(`https://example.com/?token=${env.APP_TOKEN}`);
		const result = await authenticate(request, env);
		expect(result.ok).toBe(false);
	});
});
