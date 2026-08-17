export interface RawEmailOptions {
	from: string;
	to: string;
	subject: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string;
	date?: string;
	text?: string;
	html?: string;
}

export interface BuiltRawEmail {
	raw: string;
	headers: Record<string, string>;
}

/** Builds a minimal RFC 5322 message and the header map used to build it, for feeding into `PostalMime` and a fake `ForwardableEmailMessage`. */
export function buildRawEmail(options: RawEmailOptions): BuiltRawEmail {
	const headers: Record<string, string> = {
		From: options.from,
		To: options.to,
		Subject: options.subject,
		Date: options.date ?? new Date().toUTCString(),
		"MIME-Version": "1.0",
	};
	if (options.messageId) headers["Message-ID"] = options.messageId;
	if (options.inReplyTo) headers["In-Reply-To"] = options.inReplyTo;
	if (options.references) headers["References"] = options.references;

	let body: string;
	if (options.html && options.text) {
		const boundary = "----test-boundary----";
		headers["Content-Type"] = `multipart/alternative; boundary="${boundary}"`;
		body = [
			`--${boundary}`,
			`Content-Type: text/plain; charset="utf-8"`,
			"",
			options.text,
			`--${boundary}`,
			`Content-Type: text/html; charset="utf-8"`,
			"",
			options.html,
			`--${boundary}--`,
			"",
		].join("\r\n");
	} else if (options.html) {
		headers["Content-Type"] = `text/html; charset="utf-8"`;
		body = options.html;
	} else {
		headers["Content-Type"] = `text/plain; charset="utf-8"`;
		body = options.text ?? "";
	}

	const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
	const raw = `${headerLines.join("\r\n")}\r\n\r\n${body}`;
	return { raw, headers };
}

/** Builds a fake `ForwardableEmailMessage` for unit-testing the `email()` handler without a real Email Routing delivery. */
export function createFakeMessage(raw: string, headers: Record<string, string>, envelopeFrom: string, envelopeTo: string) {
	let rejectReason: string | undefined;
	const bytes = new TextEncoder().encode(raw);
	const body = new Response(bytes).body;
	if (!body) throw new Error("Failed to construct a raw email body stream.");

	const message: ForwardableEmailMessage = {
		from: envelopeFrom,
		to: envelopeTo,
		raw: body,
		headers: new Headers(headers),
		rawSize: bytes.byteLength,
		setReject(reason: string) {
			rejectReason = reason;
		},
		async forward(): Promise<EmailSendResult> {
			return { messageId: "fake-forward-id" };
		},
		async reply(): Promise<EmailSendResult> {
			return { messageId: "fake-reply-id" };
		},
	};

	return {
		message,
		getRejectReason: () => rejectReason,
	};
}
