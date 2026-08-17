import type { ApiEmailAddress } from "./types";

export function nowIso(): string {
	return new Date().toISOString();
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
	const buffer = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
	const digest = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && EMAIL_PATTERN.test(value.trim());
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Parses a raw JSON column back into a typed value, tolerating malformed/missing data. */
export function parseJsonColumn<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

const SNIPPET_MAX_LENGTH = 160;

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<[^>]*>/g, " ");
}

/** Builds a short preview from plain text, falling back to stripped HTML. */
export function generateSnippet(text: string | undefined | null, html: string | undefined | null): string {
	const source = text && text.trim().length > 0 ? text : html ? stripHtml(html) : "";
	const collapsed = source
		.replace(/\s+/g, " ")
		.replace(/\s+([.,!?;:])/g, "$1")
		.trim();
	if (!collapsed) return "";
	return collapsed.length > SNIPPET_MAX_LENGTH ? `${collapsed.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}\u2026` : collapsed;
}

export function normalizeAddressList(input: unknown): ApiEmailAddress[] {
	if (!Array.isArray(input)) return [];
	const out: ApiEmailAddress[] = [];
	for (const entry of input) {
		if (!entry || typeof entry !== "object") continue;
		const address = (entry as Record<string, unknown>).address;
		const name = (entry as Record<string, unknown>).name;
		if (isValidEmailAddress(address)) {
			out.push({ address: address.trim(), name: typeof name === "string" && name.trim() ? name.trim() : null });
		}
	}
	return out;
}
