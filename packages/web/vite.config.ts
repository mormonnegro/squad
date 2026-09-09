import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where a plane on this machine is listening, which is what `pnpm dev` develops against. */
const PLANE = process.env.SQUAD_WEB_ORIGIN ?? "http://127.0.0.1:8789";

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
	const state = process.env.SQUAD_STATE ?? join(homedir(), ".squad", "here");
	try {
		return readFileSync(join(state, "web.token"), "utf8").trim();
	} catch {
		return undefined;
	}
}

const held = token();
const carried = held === undefined ? {} : { headers: { cookie: `squad_web=${held}` } };

export default defineConfig({
	plugins: [react()],
	build: {
		// Served by the plane out of its own directory, so the addresses in the HTML are its own.
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		// The two addresses that are the plane's rather than the page's. Everything else is this
		// server's, so a reload deep inside the application is answered here and not forwarded.
		proxy: {
			"/rpc": { target: PLANE, changeOrigin: false, ...carried },
			"/events": { target: PLANE, changeOrigin: false, ...carried },
		},
	},
});
