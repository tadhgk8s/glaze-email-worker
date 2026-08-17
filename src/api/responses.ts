/**
 * Shared JSON response envelopes and error codes. See draft-spec.md §10-§12.
 *
 * Never put SQL, stack traces, secrets, binding details, or raw provider
 * errors into a response body — only sanitized codes and messages.
 */

export type ApiErrorCode =
	| "INVALID_REQUEST"
	| "AUTH_REQUIRED"
	| "AUTH_INVALID"
	| "MESSAGE_NOT_FOUND"
	| "SEND_IN_PROGRESS"
	| "SEND_STATUS_UNKNOWN"
	| "IDEMPOTENCY_CONFLICT"
	| "VALIDATION_FAILED"
	| "EMAIL_SEND_FAILED"
	| "DATABASE_UNAVAILABLE"
	| "INTERNAL_ERROR";

const ERROR_STATUS: Record<ApiErrorCode, number> = {
	INVALID_REQUEST: 400,
	AUTH_REQUIRED: 401,
	AUTH_INVALID: 401,
	MESSAGE_NOT_FOUND: 404,
	SEND_IN_PROGRESS: 409,
	SEND_STATUS_UNKNOWN: 409,
	IDEMPOTENCY_CONFLICT: 409,
	VALIDATION_FAILED: 422,
	EMAIL_SEND_FAILED: 502,
	DATABASE_UNAVAILABLE: 503,
	INTERNAL_ERROR: 500,
};

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
	INVALID_REQUEST: "The request was malformed.",
	AUTH_REQUIRED: "An Authorization bearer token is required.",
	AUTH_INVALID: "The provided token is incorrect.",
	MESSAGE_NOT_FOUND: "The requested message does not exist.",
	SEND_IN_PROGRESS: "A matching send request is still running.",
	SEND_STATUS_UNKNOWN: "A matching send request may have completed.",
	IDEMPOTENCY_CONFLICT: "The idempotency key was reused with a different payload.",
	VALIDATION_FAILED: "The recipients or content failed validation.",
	EMAIL_SEND_FAILED: "Email Sending returned an error.",
	DATABASE_UNAVAILABLE: "The database is temporarily unavailable.",
	INTERNAL_ERROR: "An unexpected, sanitized failure occurred.",
};

export function statusForCode(code: ApiErrorCode): number {
	return ERROR_STATUS[code];
}

/** Thrown by handlers; caught once at the router boundary and turned into a response. */
export class ApiError extends Error {
	readonly code: ApiErrorCode;

	constructor(code: ApiErrorCode, message?: string) {
		super(message ?? ERROR_MESSAGES[code]);
		this.name = "ApiError";
		this.code = code;
	}
}

export function createRequestId(): string {
	return crypto.randomUUID();
}

function jsonHeaders(noStore: boolean): Headers {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (noStore) headers.set("Cache-Control", "no-store");
	return headers;
}

export function jsonSuccess(data: unknown, requestId: string, options?: { status?: number; noStore?: boolean }): Response {
	const noStore = options?.noStore ?? true;
	return new Response(JSON.stringify({ data, meta: { requestId } }), {
		status: options?.status ?? 200,
		headers: jsonHeaders(noStore),
	});
}

export function jsonError(code: ApiErrorCode, requestId: string, message?: string, options?: { noStore?: boolean }): Response {
	const noStore = options?.noStore ?? true;
	return new Response(
		JSON.stringify({
			error: {
				code,
				message: message ?? ERROR_MESSAGES[code],
				requestId,
			},
		}),
		{ status: ERROR_STATUS[code], headers: jsonHeaders(noStore) },
	);
}
