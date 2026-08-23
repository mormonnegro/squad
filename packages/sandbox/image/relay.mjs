#!/usr/bin/env node
// Pipes this process's stdio to a unix socket inside the sandbox.
//
// The control plane reaches the agent through `docker exec`, which gives a duplex stdio channel
// but cannot dial a socket directly. Running this as the exec'd command turns that channel into a
// connection to the in-container server, so no port is published and the sandbox network stays
// internal.
import { createConnection } from "node:net";

const socketPath = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 10_000);

// stderr is a pipe here, so writes are asynchronous and process.exit would discard them. Exiting
// from the flush callback is what makes a relay failure visible to the control plane rather than
// looking like a silent hang.
function fail(message, code) {
	process.exitCode = code;
	process.stderr.write(`relay: ${message}\n`, () => process.exit(code));
}

if (!socketPath) {
	fail("usage: relay.mjs <socket-path> [connect-timeout-ms]", 2);
}

const deadline = Date.now() + timeoutMs;

// The server is usually still binding when the first client arrives, so a refused connection is
// expected rather than fatal until the deadline passes.
function connect() {
	const socket = createConnection(socketPath);
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
			fail(`timed out connecting to ${socketPath}`, 1);
			return;
		}
		fail(error.message, 1);
	});

	// A failed attempt also emits close; exiting on it would swallow both the retry and the error.
	socket.once("close", () => {
		if (connected) process.exit(0);
	});
}

if (socketPath) connect();
