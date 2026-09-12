import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Which plane on this machine `pnpm dev` develops against.
 *
 * One name rather than an address and a directory. A deployment's port comes from a hash of its
 * name, so the port is not something anybody should be looking up and typing — and getting it wrong
 * means developing against the wrong plane, which looks like the change not working.
 *
 *   SQUAD_NAME=casa pnpm dev
 */
const NAME = process.env.SQUAD_NAME ?? "squad";
const PLANE = process.env.SQUAD_WEB_ORIGIN ?? `http://127.0.0.1:${portOf(NAME)}`;

/** The port that deployment published, read from the file the installer wrote it into. */
function portOf(name: string): string {
	try {
		const env = readFileSync(join(homedir(), ".squad", name, "app", "deploy", ".env"), "utf8");
		return /^SQUAD_WEB_PORT=(\d+)$/m.exec(env)?.[1] ?? "8789";
	} catch {
		// A name nobody installed under, or a server's layout. 8789 is what a first install takes.
		return "8789";
	}
}

/**
 * The plane's token, for the dev server to carry on the browser's behalf.
 *
 * In production the page and the plane are one origin, so the cookie set when the token was spent
 * goes back on every request. A dev server is a second origin and that cookie never reaches it, so
 * without this every proxied request is a 401 and the screen is a login wall with no login on it.
 *
 * Read from the state directory rather than passed on the command line, which keeps it the same
 * question it is everywhere else: whoever can read that file is whoever may drive the plane.
 */
function token(): string | undefined {
	const named = process.env.SQUAD_WEB_TOKEN;
	if (named !== undefined && named.length > 0) return named;
	for (const state of stateDirs()) {
		try {
			return readFileSync(join(state, "web.token"), "utf8").trim();
		} catch {
			// The next one. A directory with no token in it is a plane that has not come up, or a name
			// nobody installed, and neither is worth stopping for.
		}
	}
	return undefined;
}

/**
 * Where a plane on this machine keeps its state, most specific first.
 *
 * It used to be one path — `~/.squad/here` — from when there was one deployment and it had no name.
 * There are names now, and that path stopped existing, so the dev server carried no token, every
 * proxied request came back 401, and the screen said the plane had gone. Which was true of the
 * connection and not of the plane, and impossible to tell apart from the outside.
 */
function stateDirs(): string[] {
	const asked = process.env.SQUAD_STATE;
	if (asked !== undefined && asked.length > 0) return [asked];
	return [
		join(homedir(), ".squad", NAME, "state"),
		// What every install before names wrote, for a machine that still has one.
		join(homedir(), ".squad", "here"),
	];
}

const held = token();
const carried = held === undefined ? {} : { headers: { cookie: `squad_web=${held}` } };

export default defineConfig({
	plugins: [react(), tailwind()],
	// Relative, because this bundle is served from two places that disagree about where the root is:
	// the plane serves it at /, and a website serves it under a path. Absolute asset addresses work
	// in the first and 404 in the second, and they fail as a blank page with a clean console, which
	// is the worst way for a deploy to be wrong.
	base: "./",
	build: {
		// Served by the plane out of its own directory, so the addresses in the HTML are its own.
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		/*
		 * The addresses that are the plane's rather than the page's.
		 *
		 * Everything else is this server's, so a reload deep inside the application — a conversation,
		 * the plugins — is answered here with the page and not forwarded. These five are doors: two
		 * carry the protocol, and the other two are how a browser gets in and who else may — the list of
		 * browsers that hold a key, and the invitations that were handed out.
		 *
		 * `/devices` was missing, and the shape of that failure is worth remembering: an unproxied
		 * path is not a 404, it is this server's index.html, so a screen asking for JSON was handed a
		 * page and said `Unexpected token '<'`. Nothing about that message names the proxy.
		 */
		proxy: {
			"/rpc": { target: PLANE, changeOrigin: false, ...carried },
			"/events": { target: PLANE, changeOrigin: false, ...carried },
			"/devices": { target: PLANE, changeOrigin: false, ...carried },
			"/invites": { target: PLANE, changeOrigin: false, ...carried },
			// A port an agent opened, which is the plane's too — and the one that has to carry an
			// upgrade, because a dev server in a sandbox talks over a websocket.
			"/at": { target: PLANE, changeOrigin: false, ws: true, ...carried },
		},
	},
});
