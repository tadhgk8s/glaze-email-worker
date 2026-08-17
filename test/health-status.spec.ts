import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
	it("is public and reveals no mailbox configuration", async () => {
		const response = await SELF.fetch("https://example.com/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok", service: "cloudflare-mail-worker" });
	});
});

describe("GET /v1/status", () => {
	it("rejects unauthenticated requests", async () => {
		const response = await SELF.fetch("https://example.com/v1/status");
		expect(response.status).toBe(401);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("AUTH_REQUIRED");
	});

	it("returns mailbox info for an authenticated request", async () => {
		const response = await SELF.fetch("https://example.com/v1/status", {
			headers: { Authorization: `Bearer ${env.APP_TOKEN}` },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");

		const body = (await response.json()) as {
			data: { apiVersion: number; mailbox: { address: string; displayName: string } };
			meta: { requestId: string };
		};
		expect(body.data.apiVersion).toBe(1);
		expect(body.data.mailbox.address).toBe(env.MAILBOX_ADDRESS);
		expect(body.data.mailbox.displayName).toBe(env.MAILBOX_DISPLAY_NAME);
		expect(body.meta.requestId).toBeTruthy();
	});
});
