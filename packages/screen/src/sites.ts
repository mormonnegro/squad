/**
 * What a site is, for the half of signing in that the plane decides.
 *
 * The other half of this lives in the screen image, where the browser matches a vault entry against
 * the page it is on. Two copies rather than one import, for the reason the relay is two files: what
 * runs in that container is copied into it a file at a time, and a container cannot reach out of its
 * own build context. A test holds the two of them against each other and fails on the day they
 * disagree — which is the day an operator opens `github.com` and an agent is refused at `github.com`.
 */

/**
 * The site an address is for, which is what an operator types and what a page has in common.
 *
 * Everything is cut down to the host: `www.` because it is not a different site, the scheme and the
 * path because a permission to sign into a site is not a permission about one of its pages, and the
 * case because nobody typing a host means the capital letters.
 */
export function siteHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return url
			.trim()
			.replace(/^www\./, "")
			.toLowerCase();
	}
}

/**
 * Whether a host is one somebody could have meant, checked before it is written down.
 *
 * A typo here is not refused at the proxy the way a bad grant is — it is a line in a list that
 * silently matches nothing, and the operator finds out when the agent says it was not let in. So a
 * host with no dot in it, a space, or a scheme still attached is turned away while the person who
 * typed it is still looking at the screen.
 */
export function readSite(said: string): string | undefined {
	const host = siteHost(said);
	if (host === "" || host.length > 253) return undefined;
	if (!/^[a-z0-9.-]+$/.test(host)) return undefined;
	if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return undefined;
	return host;
}
