import { describe, expect, it } from "vitest";
import { readEgress } from "../image/forward.ts";

describe("the credential the browser will not carry", () => {
	it("splits the proxy into somewhere to dial and a header to write", () => {
		const egress = readEgress("http://scout:secret@egress:8080");
		expect(egress).toEqual({
			host: "egress",
			port: 8080,
			authorization: `Basic ${Buffer.from("scout:secret").toString("base64")}`,
		});
	});

	it("decodes what the URL encoded, because basic auth wants the bytes back", () => {
		// Agent names and tokens go into that URL through encodeURIComponent. A token with a `+` or a
		// `/` in it would authenticate as something else entirely if it were passed through as written.
		const egress = readEgress("http://scout:a%2Fb%2Bc@egress:8080");
		expect(
			Buffer.from(egress?.authorization.slice("Basic ".length) ?? "", "base64").toString(),
		).toBe("scout:a/b+c");
	});

	it("says nothing rather than guessing when there is no proxy to speak of", () => {
		expect(readEgress(undefined)).toBeUndefined();
		expect(readEgress("")).toBeUndefined();
		expect(readEgress("not a url")).toBeUndefined();
	});
});
