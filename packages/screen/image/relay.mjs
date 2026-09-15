#!/usr/bin/env node
// Pipes this process's stdio to a socket inside the sandbox: a unix path, or a port on loopback.
//
// The control plane reaches the agent through `docker exec`, which gives a duplex stdio channel
// but cannot dial a socket directly. Running this as the exec'd command turns that channel into a
// connection to the in-container server, so no port is published and the sandbox network stays
// internal.
//
// A port is loopback and only loopback, which is the whole reason a port is safe to relay at all.
// Sandboxes share one network and can dial each other by name, so a server bound to 0.0.0.0 in one
// of them is a server every other agent on the plane can reach. Coming in this way reaches what is
// bound to 127.0.0.1 as well, so an agent that keeps its server on loopback is reachable by its
// operator and by nobody else at all.
import { createConnection } from "node:net";

const target = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 10_000);
const port = /^\d+$/.test(target ?? "") ? Number(target) : undefined;
const where = port === undefined ? { path: target } : { port, host: "127.0.0.1" };

// stderr is a pipe here, so writes are asynchronous and process.exit would discard them. Exiting
// from the flush callback is what makes a relay failure visible to the control plane rather than
// looking like a silent hang.
function fail(message, code) {
	process.exitCode = code;
	process.stderr.write(`relay: ${message}\n`, () => process.exit(code));
}

if (!target) {
	fail("usage: relay.mjs <socket-path|port> [connect-timeout-ms]", 2);
}

const deadline = Date.now() + timeoutMs;

// The server is usually still binding when the first client arrives, so a refused connection is
// expected rather than fatal until the deadline passes.
function connect() {
	const socket = createConnection(where);
	let connected = false;

	socket.once("connect", () => {
		connected = true;
		process.stdin.pipe(socket);
		socket.pipe(process.stdout);
	});

	socket.once("error", (error) => {
		if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
			if (Date.now() < deadline) {
				setTimeout(connect, 50);
				return;
			}
			fail(`timed out connecting to ${target}`, 1);
			return;
		}
		fail(error.message, 1);
	});

	// A failed attempt also emits close; exiting on it would swallow both the retry and the error.
	socket.once("close", () => {
		if (connected) process.exit(0);
	});
}

if (target) connect();
