import { ControlError, type Dial, dialLocal } from "@agent-dive/control-plane";
import { cli as planeCli } from "@agent-dive/control-plane/cli";
import { clientHome, describePlane, type Plane, readPlane, writePlane } from "./plane.ts";
import { pickPlane, settle } from "./setup.ts";
import { dialOverSsh } from "./ssh.ts";

/**
 * The client's commands, which are not quite the plane's.
 *
 * `run` and `relay` are missing on purpose: they are things a machine does to host a plane, and
 * this is the thing an operator types at one. What is left is the same list either way, because a
 * plane answers the same protocol however far away it is.
 */
function usage(plane: Plane | undefined): string {
	return `agent - the console for self-hosted cloud agents

  agent                        the console: every agent, its turns and its logs on
                               one screen
  agent chat [name]            talk to one agent in the scrollback, turn after turn.
                               A name no agent answers to offers to make one
  agent ls                     what each agent is and whether it is up
  agent wake [name] <text>     take one turn, as the operator
  agent logs                   follow what every agent runs, answers and spends
  agent rm <name> [--purge]    take the sandbox away, and with --purge its
                               repository: soul, memory, skills, tools
  agent connect                where the agents live: a plane on this computer, or
                               one on a machine you have SSH to. Asked on the first
                               run and remembered — run it again to move
  agent help                   this

${plane === undefined ? "Nowhere yet: the first `agent` asks where." : `Your plane is ${describePlane(plane)}.`}`;
}

function dialFor(plane: Plane, home: string): Dial {
	return plane.kind === "server" ? dialOverSsh(plane.target, home) : dialLocal(plane.stateDir);
}

/**
 * Asks where the agents should live, puts a plane there, and writes the answer down.
 *
 * The wait at the end is not politeness. `docker compose up -d` comes back when the container has
 * started, which is a moment before the process inside it is listening, and being told there is no
 * plane seconds after watching one being built is the worst version of this minute.
 */
async function chosen(home: string): Promise<Plane> {
	const plane = await pickPlane(home);
	await writePlane(home, plane);
	await settle(dialFor(plane, home));
	return plane;
}

/**
 * Hands the command to the plane's own CLI, pointed at the plane this operator has.
 *
 * Everything past this line is the same code in both cases. A plane here is named by its state
 * directory, which the CLI already knows how to find things in; a plane on a server is named by a
 * way to dial it, and the commands never learn the difference.
 *
 * The directory goes in front of the operator's own arguments rather than after them, so
 * `--state` typed by hand still wins.
 */
async function drive(plane: Plane, home: string, argv: readonly string[]): Promise<void> {
	if (plane.kind === "here") return planeCli(["--state", plane.stateDir, ...argv]);
	return planeCli(argv, { at: plane.target, dial: dialOverSsh(plane.target, home) });
}

export async function cli(argv: readonly string[]): Promise<void> {
	const home = clientHome();
	const [command] = argv;

	if (command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(`${usage(await readPlane(home))}\n`);
		return;
	}

	try {
		if (process.platform === "win32") {
			throw new ControlError("This drives ssh and sh, which Windows has no version of. Use WSL.");
		}
		// Choosing is also connecting: the operator who just said where the plane goes wants to be in
		// front of it, not back at a prompt being told it worked.
		const plane =
			command === "connect"
				? await chosen(home)
				: ((await readPlane(home)) ?? (await chosen(home)));
		await drive(plane, home, command === "connect" ? argv.slice(1) : argv);
	} catch (error) {
		if (error instanceof ControlError) process.stderr.write(`\n${error.message}\n\n`);
		else process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	}
}
