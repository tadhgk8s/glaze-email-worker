/** Domain-level address shape used across the API and database (matches the JSON API convention: `address`/`name`). */
export interface ApiEmailAddress {
	address: string;
	name: string | null;
}

export type MessageDirection = "inbound" | "outbound";
export type MessageStatus = "received" | "sending" | "sent" | "failed" | "unknown";
export type SendRequestStatus = "preparing" | "sending" | "sent" | "failed" | "unknown";
