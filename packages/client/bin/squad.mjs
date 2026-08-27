#!/usr/bin/env node
//
//   squad
//
// The console, and on the first run the one question it needs answered: which machine the agents
// should live on. Everything past that question is the same program either way — a plane answers
// the same protocol whether it is in a container on this computer or at the end of an SSH
// connection — so only the first minute knows the difference.

// Asked about the capability rather than the version, because that is the thing that decides it and
// it arrived in two release lines at different numbers. Without it the first `.ts` import fails
// with a message about an unknown file extension, which says nothing about what to do.
if (!process.features.typescript) {
	process.stderr.write(
		"squad runs its own TypeScript, which needs Node 22.18 or 23.6 or newer.\n" +
			`This is Node ${process.versions.node}.\n`,
	);
	process.exit(1);
}

// Type stripping warns once per process that it is experimental. It is a true thing to say to
// whoever ships this and a useless thing to say to whoever runs it, and it lands on the console's
// first frame.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
	const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
	if (type === "ExperimentalWarning") return;
	emitWarning(warning, ...rest);
};

const { cli } = await import("../src/cli.ts");
await cli(process.argv.slice(2));
