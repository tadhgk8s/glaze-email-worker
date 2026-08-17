import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb, schema } from "../src/db/client";
import type { NewMessage } from "../src/db/schema";
import { nowIso } from "../src/util";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${env.APP_TOKEN}`, ...extra };
}

async function insertMessage(overrides: Partial<NewMessage> = {}): Promise<string> {
	const db = createDb(env);
	const id = overrides.id ?? crypto.randomUUID();
	const timestamp = nowIso();
	await db.insert(schema.messages).values({
		id,
		threadId: crypto.randomUUID(),
		direction: "inbound",
		status: "received",
		referencesJson: "[]",
		fromJson: JSON.stringify({ address: "person@example.net", name: "Person" }),
		toJson: JSON.stringify([{ address: env.MAILBOX_ADDRESS, name: null }]),
		ccJson: "[]",
		bccJson: "[]",
		subject: "Quarterly report",
		snippet: "Please find attached the quarterly report",
		bodyText: "Please find attached the quarterly report for review.",
		bodyHtml: null,
		isRead: false,
		receivedAt: timestamp,
		sentAt: null,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	});
	return id;
}

describe("DELETE /v1/messages/:id", () => {
	it("soft-deletes a message and moves it into the trash folder", async () => {
		const id = await insertMessage();

		const del = await SELF.fetch(`https://example.com/v1/messages/${id}`, { method: "DELETE", headers: authHeaders() });
		expect(del.status).toBe(200);
		const delBody = (await del.json()) as { data: { id: string; deletedAt: string } };
		expect(delBody.data.id).toBe(id);
		expect(delBody.data.deletedAt).toBeTruthy();

		const inbox = await SELF.fetch("https://example.com/v1/messages?folder=inbox", { headers: authHeaders() });
		const inboxBody = (await inbox.json()) as { data: { messages: Array<{ id: string }> } };
		expect(inboxBody.data.messages.map((m) => m.id)).not.toContain(id);

		const trash = await SELF.fetch("https://example.com/v1/messages?folder=trash", { headers: authHeaders() });
		const trashBody = (await trash.json()) as { data: { messages: Array<{ id: string }> } };
		expect(trashBody.data.messages.map((m) => m.id)).toContain(id);
	});

	it("returns 404 for an unknown id", async () => {
		const response = await SELF.fetch(`https://example.com/v1/messages/${crypto.randomUUID()}`, { method: "DELETE", headers: authHeaders() });
		expect(response.status).toBe(404);
	});

	it("rejects unauthenticated requests", async () => {
		const id = await insertMessage();
		const response = await SELF.fetch(`https://example.com/v1/messages/${id}`, { method: "DELETE" });
		expect(response.status).toBe(401);
	});
});

describe("PATCH /v1/messages/:id (star/archive)", () => {
	it("stars a message and lists it under the starred folder", async () => {
		const id = await insertMessage();

		const patch = await SELF.fetch(`https://example.com/v1/messages/${id}`, {
			method: "PATCH",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ isStarred: true }),
		});
		expect(patch.status).toBe(200);
		const patchBody = (await patch.json()) as { data: { isStarred: boolean } };
		expect(patchBody.data.isStarred).toBe(true);

		const starred = await SELF.fetch("https://example.com/v1/messages?folder=starred", { headers: authHeaders() });
		const starredBody = (await starred.json()) as { data: { messages: Array<{ id: string }> } };
		expect(starredBody.data.messages.map((m) => m.id)).toContain(id);
	});

	it("archives a message, removing it from the inbox and listing it under archived", async () => {
		const id = await insertMessage();

		await SELF.fetch(`https://example.com/v1/messages/${id}`, {
			method: "PATCH",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ isArchived: true }),
		});

		const inbox = await SELF.fetch("https://example.com/v1/messages?folder=inbox", { headers: authHeaders() });
		const inboxBody = (await inbox.json()) as { data: { messages: Array<{ id: string }> } };
		expect(inboxBody.data.messages.map((m) => m.id)).not.toContain(id);

		const archived = await SELF.fetch("https://example.com/v1/messages?folder=archived", { headers: authHeaders() });
		const archivedBody = (await archived.json()) as { data: { messages: Array<{ id: string }> } };
		expect(archivedBody.data.messages.map((m) => m.id)).toContain(id);
	});

	it("rejects a body with no recognized fields", async () => {
		const id = await insertMessage();
		const response = await SELF.fetch(`https://example.com/v1/messages/${id}`, {
			method: "PATCH",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ subject: "nope" }),
		});
		expect(response.status).toBe(400);
	});

	it("supports patching multiple fields in one request", async () => {
		const id = await insertMessage();
		const response = await SELF.fetch(`https://example.com/v1/messages/${id}`, {
			method: "PATCH",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ isRead: true, isStarred: true }),
		});
		const body = (await response.json()) as { data: { isRead: boolean; isStarred: boolean } };
		expect(body.data.isRead).toBe(true);
		expect(body.data.isStarred).toBe(true);
	});
});

describe("GET /v1/search", () => {
	it("requires authentication", async () => {
		const response = await SELF.fetch("https://example.com/v1/search?q=report");
		expect(response.status).toBe(401);
	});

	it("requires a query", async () => {
		const response = await SELF.fetch("https://example.com/v1/search", { headers: authHeaders() });
		expect(response.status).toBe(400);
	});

	it("finds messages by subject, snippet, or body text", async () => {
		const matchId = await insertMessage({ subject: "Quarterly report", bodyText: "See the numbers attached." });
		await insertMessage({ subject: "Lunch plans", snippet: "Want to grab lunch?", bodyText: "Free at noon?" });

		const response = await SELF.fetch("https://example.com/v1/search?q=quarterly", { headers: authHeaders() });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { messages: Array<{ id: string }> } };
		expect(body.data.messages.map((m) => m.id)).toEqual([matchId]);
	});

	it("excludes deleted messages from results", async () => {
		const id = await insertMessage({ subject: "Deleted report" });
		await SELF.fetch(`https://example.com/v1/messages/${id}`, { method: "DELETE", headers: authHeaders() });

		const response = await SELF.fetch("https://example.com/v1/search?q=deleted", { headers: authHeaders() });
		const body = (await response.json()) as { data: { messages: Array<{ id: string }> } };
		expect(body.data.messages.map((m) => m.id)).not.toContain(id);
	});
});
