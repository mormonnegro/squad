#!/usr/bin/env node
//
//   npx agent-dive
//
// The whole install, typed on the computer you are sitting at. It asks one question — which machine
// the agents should live on — and does the rest over the SSH connection you already have to it, so
// there is no session on the VPS to open and nothing to paste into one.
//
// It is thin on purpose. The two halves of the install are shell scripts that stand on their own
// (`deploy/install.sh` on the machine, `deploy/connect.sh` here), and anyone who would rather read
// them and pipe them by hand still can. This runs the same two, in the same order, and knows the
// address so neither has to ask.
//
// Nothing is asked about keys. Every one of them can be given later on the setup screen in the
// console, and three secrets in the first minute is a worse first minute than an empty setup screen
// in the second one.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

const BASE =
	process.env.AGENT_DIVE_BASE ??
	"https://raw.githubusercontent.com/agent-dive/agent-dive/main/deploy";

const bold = (text) => (process.stdout.isTTY ? `\u001b[1m${text}\u001b[0m` : text);
const dim = (text) => (process.stdout.isTTY ? `\u001b[2m${text}\u001b[0m` : text);

function step(text) {
	process.stdout.write(`\n${bold(text)}\n`);
}

function note(text) {
	process.stdout.write(`  ${text}\n`);
}

function die(text) {
	process.stderr.write(`\n${text}\n\n`);
	process.exit(1);
}

/** Waits for a spawned process and answers with its exit code, treating a signal as a failure. */
function ran(child) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
}

/**
 * Runs a script from the repository, with its text on stdin rather than fetched at the far end.
 *
 * On stdin because the machine it lands on may not have curl yet, and because the script that
 * arrives is then the one this version was published against rather than whatever main holds today.
 */
async function pipe(script, argv) {
	const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "inherit", "inherit"] });
	child.stdin.end(script);
	return ran(child);
}

async function fetchScript(name) {
	const url = `${BASE}/${name}`;
	if (!url.startsWith("http")) {
		const { readFile } = await import("node:fs/promises");
		return readFile(url, "utf8");
	}
	const response = await fetch(url).catch((error) => {
		throw new Error(`Could not reach ${url}: ${error.message}`);
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return response.text();
}

/** A bare address is the common case, and root is who a fresh VPS gives you. */
function normalize(target) {
	const trimmed = target.trim().replace(/^ssh:\/\//, "");
	return trimmed.includes("@") ? trimmed : `root@${trimmed}`;
}

async function askWhere() {
	if (!process.stdin.isTTY) {
		die("Nothing to ask on. Give the address: npx agent-dive root@your-vps");
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write(
			`\n${bold("Where should your agents live?")}\n` +
				`  ${dim("A machine you have SSH to. A $5 VPS is enough.")}\n\n`,
		);
		// The prompt already reads `root@`, so a bare host completes the line that is on screen, and a
		// full `me@host` typed over it is still understood.
		const answer = await rl.question("  root@");
		if (answer.trim().length === 0) die("No address, so nothing to set up.");
		return normalize(answer);
	} finally {
		rl.close();
	}
}

async function main(argv) {
	if (process.platform === "win32") {
		die("This drives ssh and sh, which Windows has no version of. Use WSL.");
	}

	const target = argv[0] ? normalize(argv[0]) : await askWhere();

	// One connection that both proves the address and says whether there is anything to install, so
	// a machine that already has a plane costs a second rather than a rebuild.
	step(`Reaching ${target}`);
	const probe = await ran(
		spawn("ssh", ["-o", "ConnectTimeout=20", target, "command -v agent >/dev/null 2>&1"], {
			stdio: ["inherit", "ignore", "inherit"],
		}),
	);
	if (probe === 255) die(`Could not open an SSH connection to ${target}.`);
	const installed = probe === 0;

	if (installed) {
		note("a plane is already there, so nothing was rebuilt");
	} else {
		step("Installing on that machine");
		note("Docker if it has none, the images, and the plane. This takes a few minutes.");
		const install = await fetchScript("install.sh");
		// Without a terminal on the far end the installer takes every key from the environment and
		// asks nothing, which is the behaviour wanted here: the setup screen in the console is a
		// better place for them than the minute before anything is running.
		const code = await pipe(install, ["ssh", target, "sh -s"]);
		if (code !== 0) die("The install did not finish. What it printed is above.");
	}

	step("Putting agent on this computer");
	const connect = await fetchScript("connect.sh");
	const code = await pipe(connect, ["sh", "-s", target]);
	if (code !== 0) die("Could not write the local command.");

	step("Opening the console");
	note(dim("^C leaves it. Type `agent` to come back."));
	process.stdout.write("\n");
	const console_ = spawn("agent", [], { stdio: "inherit" });
	const status = await ran(console_).catch(() => {
		// Written to a directory that was on the PATH when it was chosen, so this is a shell that has
		// not looked again rather than a file that is missing.
		note("Open a new terminal and type `agent`.");
		return 0;
	});
	process.exit(status);
}

main(process.argv.slice(2)).catch((error) => {
	die(error instanceof Error ? error.message : String(error));
});
