import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where a plane on this machine is listening, which is what `pnpm dev` develops against. */
const PLANE = process.env.SQUAD_WEB_ORIGIN ?? "http://127.0.0.1:8789";

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
			"/rpc": { target: PLANE, changeOrigin: false },
			"/events": { target: PLANE, changeOrigin: false },
		},
	},
});
