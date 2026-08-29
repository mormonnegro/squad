// The one place the repository is named. There is no git remote configured yet, so change this and
// every link on the site follows, including the URL the install command reads from.
export const REPO = "https://github.com/mormonnegro/squad";

// This site, and so where the two installers are served from. They are not written here: the build
// copies them out of deploy/, so the line somebody pipes into a shell is byte for byte the file in
// the repository and cannot drift from it.
export const SITE = "https://squad.mormon.garden";

/** On the machine the agents will live on, whether that is a server or this computer. */
export const INSTALL = `${SITE}/install.sh`;

// On the computer you sit at. Not an npm package: the console is eight workspace packages that only
// mean anything together, and publishing eight names in lockstep to distribute one command is a
// release process standing in for a download.
export const CLIENT = `${SITE}/client.sh`;

export const PI = "https://github.com/earendil-works/pi";

export const TITLE = "squad";

// The hero reads this and so does the meta description, because a page that describes itself one way
// to a reader and another way to a search result is describing two different projects.
export const TAGLINE =
	"Cloud agents on a machine you own. Give one a standing job: it wakes on its own, does it, and writes back.";
