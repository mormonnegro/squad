import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ControlError, type Dial } from "@agent-dive/control-plane";
import { localStateDir, normalizeTarget, type Plane } from "./plane.ts";

/**
 * Where the server half is fetched from, and a local path in development.
 *
 * The install is a shell script that stands on its own, and anyone who would rather read it and
 * pipe it by hand still can. This runs the same one.
 */
const BASE =
	process.env.AGENT_DIVE_BASE ??
	"https://raw.githubusercontent.com/agent-dive/agent-dive/main/deploy";

const bold = (text: string): string => (process.stdout.isTTY ? `\u001b[1m${text}\u001b[0m` : text);
const dim = (text: string): string => (process.stdout.isTTY ? `\u001b[2m${text}\u001b[0m` : text);

function step(text: string): void {
	process.stdout.write(`\n${bold(text)}\n`);
}

function note(text: string): void {
	process.stdout.write(`  ${text}\n`);
}

/**
 * One key, and the prompt says which ones it answers to.
 *
 * A choice between two machines is not worth a word and a newline. Raw mode is put back before
 * anything else reads the terminal, and ^C leaves — which is the only key that always works here
 * and so the only one not worth listing.
 */
const NOBODY = new ControlError("Nothing to ask on. Run `agent` in a terminal.");

async function oneOf(keys: readonly string[]): Promise<string> {
	const stdin = process.stdin;
	if (stdin.isTTY !== true) throw NOBODY;

	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	try {
		for (;;) {
			const pressed = await new Promise<string>((resolve) => stdin.once("data", resolve));
			if (pressed === "\u0003") {
				process.stdout.write("\n");
				process.exit(130);
			}
			const key = pressed.toLowerCase();
			if (keys.includes(key)) {
				process.stdout.write("\n");
				return key;
			}
		}
	} finally {
		stdin.setRawMode(false);
		stdin.pause();
	}
}

async function askLine(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await rl.question(prompt);
	} finally {
		rl.close();
	}
}

/** Waits for a spawned process and answers with its exit code, treating a signal as a failure. */
function ran(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
}

/**
 * Runs the install with its text on stdin rather than fetched at the far end.
 *
 * On stdin because the machine it lands on may not have curl yet, and because the script that
 * arrives is then the one this version was published against rather than whatever main holds today.
 */
async function pipe(script: string, argv: string[], env: NodeJS.ProcessEnv = {}): Promise<number> {
	const child = spawn(argv[0] as string, argv.slice(1), {
		stdio: ["pipe", "inherit", "inherit"],
		env: { ...process.env, ...env },
	});
	child.stdin?.end(script);
	return ran(child);
}

async function installer(): Promise<string> {
	const url = `${BASE}/install.sh`;
	if (!url.startsWith("http")) {
		const { readFile } = await import("node:fs/promises");
		return readFile(url, "utf8");
	}
	const response = await fetch(url).catch((error: Error) => {
		throw new ControlError(`Could not reach ${url}: ${error.message}`);
	});
	if (!response.ok) throw new ControlError(`${url} answered ${response.status}`);
	return response.text();
}

async function dockerIsUp(): Promise<boolean> {
	const child = spawn("docker", ["info"], { stdio: "ignore" });
	return (await ran(child).catch(() => 1)) === 0;
}

/**
 * The question, asked once and remembered after that.
 *
 * Two doors, and they differ in one thing: which machine the containers are on. Everything after
 * this — the console, the log feed, a port forwarded out of a sandbox — is the same program against
 * the same protocol either way, which is why this is the only place that has to know.
 */
export async function pickPlane(home: string): Promise<Plane> {
	// Before it is drawn rather than after: piped into anything, `agent` would otherwise print a
	// question, two doors and a prompt, and then say there was nobody there to answer it.
	if (process.stdin.isTTY !== true) throw NOBODY;

	process.stdout.write(
		`\n${bold("Where should your agents live?")}\n\n` +
			`  ${bold("1")}  On this computer   ${dim("a container here, and Docker is what runs it")}\n` +
			`  ${bold("2")}  On a server        ${dim("a machine you have SSH to. A $5 VPS is enough")}\n\n` +
			`  ${dim("1 or 2")}  `,
	);

	const chosen = await oneOf(["1", "2"]);
	return chosen === "1" ? await here(home) : await there();
}

/**
 * The plane in a container on this computer, once there is something to run containers.
 *
 * The prerequisite is checked before the choice is acted on rather than after, because the honest
 * answer to a machine without Docker is a different door and not a failed install. Both are
 * offered: whoever wants Docker can go and get it, and whoever does not has a server.
 */
async function here(home: string): Promise<Plane> {
	while (!(await dockerIsUp())) {
		process.stdout.write(
			`\n  ${bold("Docker is not answering here, and the agents are containers.")}\n\n` +
				`  ${bold("1")}  Try again          ${dim("once it is running")}\n` +
				`  ${bold("2")}  On a server        ${dim("a machine you have SSH to, which needs nothing here")}\n\n` +
				`  ${dim("docs.docker.com/get-started/get-docker — if this computer has none")}\n\n` +
				`  ${dim("1 or 2")}  `,
		);
		if ((await oneOf(["1", "2"])) === "2") return there();
	}

	const stateDir = localStateDir(home);
	step("Installing the plane on this computer");
	note("The sandbox image, the plane, and Docker's part of it. This takes a few minutes.");
	note(dim(`Everything it writes goes under ${home}.`));

	const code = await pipe(await installer(), ["sh", "-s"], {
		AGENT_DIVE_DIR: join(home, "src"),
		AGENT_DIVE_STATE: stateDir,
		// `agent` on this machine is the client that is running right now. A shim written over it
		// would take the console away from the thing that opened it.
		AGENT_DIVE_SHIM: "no",
		// The keys have a screen of their own in the console, and this has a terminal it could ask on.
		AGENT_DIVE_ASK: "no",
	});
	if (code !== 0) throw new ControlError("The install did not finish. What it printed is above.");

	return { kind: "here", stateDir };
}

/**
 * The plane on a machine at the end of an SSH connection, installed over that same connection.
 *
 * Nothing is opened on the server and nothing new is logged into. The install goes down the
 * connection the operator already has, and so does everything after it.
 */
async function there(): Promise<Plane> {
	process.stdout.write(
		`\n${bold("Which machine?")}\n` +
			`  ${dim("Anything ssh can reach. The prompt already reads root@, so a bare host finishes it.")}\n` +
			`  ${dim("An empty line says you have not got one yet.")}\n\n`,
	);

	let typed = await askLine("  root@");
	// The door for whoever picked this one without the machine it needs. The other door has the same
	// thing when Docker is not running, and an operator who is one purchase away from a plane is
	// owed the same as one who is one daemon away from it.
	if (typed.trim().length === 0) {
		process.stdout.write(
			`\n  ${bold("Any Linux with SSH on it, and the bottom of every list runs a few agents.")}\n` +
				`  ${dim("One vCPU, a gigabyte of memory, ten gigabytes of disk. The install brings Docker.")}\n\n` +
				`  hetzner.com/cloud         ${dim("the most machine for the money, in Europe and the US")}\n` +
				`  vultr.com/pricing         ${dim("from about $5, and in more places than the other two")}\n` +
				`  digitalocean.com/pricing  ${dim("a few dollars more, and the most written about")}\n\n` +
				`  ${dim("An old laptop under the desk does just as well, and so does a machine at work.")}\n\n`,
		);
		typed = await askLine("  root@");
	}
	if (typed.trim().length === 0) {
		throw new ControlError("No machine, so nothing to set up. `agent connect` asks again.");
	}
	const target = normalizeTarget(typed);

	// One connection that both proves the address and says whether there is anything to install, so
	// a machine that already has a plane costs a second rather than a rebuild.
	step(`Reaching ${target}`);
	const probe = await ran(
		spawn("ssh", ["-o", "ConnectTimeout=20", target, "command -v agent >/dev/null 2>&1"], {
			stdio: ["inherit", "ignore", "inherit"],
		}),
	);
	if (probe === 255) throw new ControlError(`Could not open an SSH connection to ${target}.`);

	if (probe === 0) {
		note("a plane is already there, so nothing was rebuilt");
	} else {
		step(`Installing the plane on ${target}`);
		note("Docker if it has none, the images, and the plane. This takes a few minutes.");
		const code = await pipe(await installer(), ["ssh", target, "sh -s"]);
		if (code !== 0) throw new ControlError("The install did not finish. What it printed is above.");
	}

	return { kind: "server", target };
}

/**
 * Holds the door open until the plane answers through it.
 *
 * `docker compose up -d` comes back when the container is started, which is a moment before the
 * process inside it is listening. Without this the first console after an install would be told
 * there is no plane, seconds after watching one being built.
 */
export async function settle(dial: Dial, seconds = 30): Promise<void> {
	const until = Date.now() + seconds * 1000;
	for (;;) {
		const socket = await dial().catch(() => undefined);
		if (socket !== undefined) {
			socket.destroy();
			return;
		}
		if (Date.now() > until) return;
		await sleep(500);
	}
}
