import { Rendezvous } from "./rendezvous.ts";

/**
 * A rendezvous, run.
 *
 * Everything it can be told is a number, because there is nothing else to tell it: it holds no
 * credential, knows no user, and stores nothing past the minute. A relay is a machine that puts two
 * sockets together, and the only decisions are how many of them and how big.
 *
 * Behind a TLS terminator in anything but a test — the traffic is already sealed, so what TLS adds
 * here is not confidentiality but the browser's willingness to talk to it from an https page.
 */
const relay = new Rendezvous({
	port: Number(process.env.PORT ?? "8790"),
	host: process.env.HOST ?? "0.0.0.0",
	...(process.env.RELAY_ROOMS === undefined ? {} : { roomLimit: Number(process.env.RELAY_ROOMS) }),
	...(process.env.RELAY_FRAME === undefined ? {} : { frameLimit: Number(process.env.RELAY_FRAME) }),
});

const port = await relay.listen();
process.stdout.write(`relay on ${port}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void relay.close().then(() => process.exit(0));
	});
}
