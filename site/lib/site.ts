// The one place the repository is named. There is no git remote configured yet, so change this and
// every link on the site follows, including the URL the install command reads from.
export const REPO = "https://github.com/agent-dive/agent-dive";

// Derived rather than written out, because the two are the same repository and a site that offers
// a `curl | sh` pointing at somebody else's fork is the worst thing on it.
export const INSTALL = `${REPO.replace("github.com", "raw.githubusercontent.com")}/main/deploy/install.sh`;

export const PI = "https://github.com/earendil-works/pi";

export const TITLE = "agent-dive";
export const TAGLINE =
	"Self-hosted cloud agents. A container that stays running, wakes when something happens, and reaches the outside world only through credentials it never sees.";
