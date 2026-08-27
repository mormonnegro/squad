import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ControlError, type Dial } from "@squad/control-plane";
import { localStateDir, normalizeTarget, type Plane } from "./plane.ts";

/**
 * Where the server half is fetched from, and a local path in development.
 *
 * The install is a shell script that stands on its own, and anyone who would rather read it and
 * pipe it by hand still can. This runs the same one.
 */
const BASE =
	process.env.SQUAD_BASE ?? "https://raw.githubusercontent.com/mormonnegro/squad/main/deploy";

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
const NOBODY = new ControlError("Nothing to ask on. Run `squad` in a terminal.");

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

/** One sh word, whatever is in it. */
const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The install, as the far end has to be told to run it.
 *
 * The script arrives on stdin but the tree it installs is cloned at the far end, and `ssh host sh`
 * carries no environment — so a machine reached this way could only ever be given the published
 * main. These two say where the tree comes from, and are the only ones worth carrying: everything
 * else the script reads is about where things go, which is the server's own business.
 */
export function remoteInstall(env: NodeJS.ProcessEnv = process.env): string {
	const carried = ["SQUAD_REPO", "SQUAD_BRANCH"]
		.filter((name) => (env[name] ?? "").length > 0)
		.map((name) => `${name}=${quoted(env[name] as string)}`);
	return [...carried, "sh -s"].join(" ");
}

/**
 * The other end of the same thing: the install, as this computer has to be told to run it.
 *
 * A server takes the script's defaults because where things go there is the server's own business.
 * A plane living beside the client has to be told all four. The shim is refused because `squad` on
 * this machine is the client that is running right now, and one written over it would take the
 * console away from the thing that opened it. The questions are refused because the keys have a
 * screen of their own in the console, and three secrets in the first minute is a worse first minute
 * than an empty setup screen in the second one.
 */
export function planeEnv(home: string, stateDir: string): NodeJS.ProcessEnv {
	return {
		SQUAD_DIR: join(home, "src"),
		SQUAD_STATE: stateDir,
		SQUAD_SHIM: "no",
		SQUAD_ASK: "no",
	};
}

/**
 * The options that let ssh try the key and nothing else.
 *
 * Every connection this makes is opened with them, so that a machine which has the key never asks
 * for anything, and a machine which has not is refused rather than left waiting on a prompt this
 * would have to answer once per connection for as long as the console is open.
 */
const KEY_ONLY = [
	"-o",
	"PasswordAuthentication=no",
	"-o",
	"KbdInteractiveAuthentication=no",
] as const;

/** Whether what ssh said is a machine turning the key down, as against one that is not there. */
const turnedDown = (said: string): boolean => said.includes("Permission denied");

/** What a process said, laid under a sentence of ours. */
const beneath = (said: string): string =>
	said
		.trim()
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");

/**
 * One connection, and what came of it.
 *
 * stdin is this terminal because a machine whose host key has never been seen has a question to ask
 * before anything else happens. stderr is held rather than printed: ssh writes its whole diagnosis
 * there, and that is worth showing when the connection fails and noise when it does not.
 */
async function reach(
	target: string,
	options: readonly string[],
): Promise<{ code: number; said: string }> {
	const child = spawn(
		"ssh",
		["-o", "ConnectTimeout=20", ...options, target, "command -v squad >/dev/null 2>&1"],
		{ stdio: ["inherit", "ignore", "pipe"] },
	);
	let said = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (text: string) => {
		said += text;
	});
	return { code: await ran(child), said };
}

/** What a program printed, or nothing at all if it would not run or did not succeed. */
async function output(program: string, argv: readonly string[]): Promise<string> {
	const child = spawn(program, argv as string[], { stdio: ["ignore", "pipe", "ignore"] });
	let text = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		text += chunk;
	});
	const code = await ran(child).catch(() => 1);
	return code === 0 ? text : "";
}

/**
 * A public key of this computer's, made if there is none.
 *
 * The agent is asked first because a key held there is the one ssh would offer, and on the machines
 * where that is a hardware token or a password manager there is no file to find. Making one is the
 * last resort and not an unusual one: a computer that has never spoken SSH has no key, and being
 * told to go and run ssh-keygen is a precondition rather than an answer.
 */
async function publicKey(): Promise<string> {
	const held = (await output("ssh-add", ["-L"]))
		.split("\n")
		.find((line) => line.startsWith("ssh-") || line.startsWith("ecdsa-"));
	if (held !== undefined) return held.trim();

	const dir = join(homedir(), ".ssh");
	for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
		const text = await readFile(join(dir, `${name}.pub`), "utf8").catch(() => "");
		if (text.trim().length > 0) return text.trim();
	}

	const path = join(dir, "id_ed25519");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	// A private key with no public one beside it is a file that ssh-keygen would rather ask about
	// than overwrite, and an unanswered question here is a hung install. Its public half is derived
	// from it instead, which is the one thing that cannot go wrong.
	const derived = await output("ssh-keygen", ["-y", "-f", path]);
	if (derived.trim().length > 0) return derived.trim();

	note(`No key on this computer, so one was made at ${path}.`);
	const made = await output("ssh-keygen", [
		"-q",
		"-t",
		"ed25519",
		"-N",
		"",
		"-C",
		"squad",
		"-f",
		path,
	]);
	if (made === "" && (await readFile(`${path}.pub`, "utf8").catch(() => "")).trim().length === 0) {
		throw new ControlError("There is no SSH key here and ssh-keygen would not make one.");
	}
	return (await readFile(`${path}.pub`, "utf8")).trim();
}

/**
 * The far end of putting a key up, with the key already in it.
 *
 * Written to be run twice: a key that is already in the file is left where it is, so a second setup
 * against the same machine costs a connection and changes nothing. The modes are set every time
 * because sshd ignores the file when they are wrong, and a directory made by something else is the
 * likeliest way for them to be.
 */
export function authorizeKey(key: string): string {
	return [
		"set -e",
		"umask 077",
		'mkdir -p "$HOME/.ssh"',
		'touch "$HOME/.ssh/authorized_keys"',
		`key=${quoted(key.trim())}`,
		'grep -qxF "$key" "$HOME/.ssh/authorized_keys" ||',
		'  printf \'%s\\n\' "$key" >> "$HOME/.ssh/authorized_keys"',
		'chmod 700 "$HOME/.ssh"',
		'chmod 600 "$HOME/.ssh/authorized_keys"',
	].join("\n");
}

/**
 * The one time a password is typed, and what it buys.
 *
 * A server bought this morning has a root password in an email and no key on it, which is the only
 * thing standing between an operator and a plane. The key goes up on the same connection the
 * password opens, so this is asked once and never again — by the install that follows it, by the
 * console, or by any of the forwarded ports the console opens later.
 *
 * The key is turned off for this one connection on purpose: an operator carrying several would
 * otherwise have them all refused in turn, and a server that stops after a few tries would hang up
 * before the password was ever offered.
 */
async function authorize(target: string): Promise<void> {
	const key = await publicKey();
	step(`${target} would not take a key, so it is asking for the password`);
	note("Typed once. Your key goes up with it, and nothing after this asks again.");
	const code = await pipe(authorizeKey(key), [
		"ssh",
		"-o",
		"ConnectTimeout=20",
		"-o",
		"PubkeyAuthentication=no",
		target,
		"sh -s",
	]);
	if (code !== 0) throw new ControlError(`Could not put a key on ${target}.`);
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
	// Before it is drawn rather than after: piped into anything, `squad` would otherwise print a
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

	const code = await pipe(await installer(), ["sh", "-s"], planeEnv(home, stateDir));
	if (code !== 0) throw new ControlError("The install did not finish. What it printed is above.");

	return { kind: "here", stateDir };
}

/**
 * The plane on a machine at the end of an SSH connection, installed over that same connection.
 *
 * Nothing is opened on the server and no account is made on it. The install goes down the
 * connection the operator already has, and so does everything after it — and where there is no
 * such connection yet, the password buys one and is then done with.
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
		throw new ControlError("No machine, so nothing to set up. `squad connect` asks again.");
	}
	const target = normalizeTarget(typed);

	// One connection that both proves the address and says whether there is anything to install, so
	// a machine that already has a plane costs a second rather than a rebuild.
	step(`Reaching ${target}`);
	let reached = await reach(target, KEY_ONLY);

	// A refused key is the one failure with something to do about it. Anything else the connection
	// could die of — a name that does not resolve, a host key that changed — is the operator's to
	// look at, and asking them for a password would only bury what ssh already said.
	if (reached.code === 255 && turnedDown(reached.said)) {
		await authorize(target);
		reached = await reach(target, KEY_ONLY);
		if (reached.code === 255) {
			throw new ControlError(
				`The key went up, but ${target} still will not take it.\n${beneath(reached.said)}`,
			);
		}
	}
	if (reached.code === 255) {
		throw new ControlError(
			`Could not open an SSH connection to ${target}.\n${beneath(reached.said)}`,
		);
	}

	if (reached.code === 0) {
		note("a plane is already there, so nothing was rebuilt — `squad update` is what rebuilds one");
	} else {
		step(`Installing the plane on ${target}`);
		note("Docker if it has none, the images, and the plane. This takes a few minutes.");
		const code = await pipe(await installer(), ["ssh", target, remoteInstall()]);
		if (code !== 0) throw new ControlError("The install did not finish. What it printed is above.");
	}

	return { kind: "server", target };
}

/**
 * Puts what main holds today on the machine the plane is already on.
 *
 * The same script the install ran, because on the server half they were never two things: it pulls,
 * rebuilds both images and swaps the plane in, and leaves config.yaml and .env exactly as they are.
 * So this asks nothing — the machine was chosen once, and an update is not that question again.
 */
export async function updatePlane(plane: Plane, home: string): Promise<void> {
	const where = plane.kind === "here" ? "this computer" : plane.target;
	step(`Updating the plane on ${where}`);
	note("The latest main, both images rebuilt, the plane swapped in. This takes a few minutes.");
	note(dim("Your config and your keys are left where they are."));

	const code =
		plane.kind === "here"
			? await pipe(await installer(), ["sh", "-s"], planeEnv(home, plane.stateDir))
			: await pipe(await installer(), ["ssh", plane.target, remoteInstall()]);
	if (code !== 0) throw new ControlError("The update did not finish. What it printed is above.");
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
