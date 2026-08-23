#!/usr/bin/env node
// Node runs the TypeScript sources directly, and before 24 it says so on stderr every time anything
// is loaded. The banner would be the first thing an operator sees on every command, so it is turned
// off here: plain JavaScript, loaded before any TypeScript is, which is the only place the filter
// can be installed in time.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
	const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
	if (type === "ExperimentalWarning") return;
	emitWarning(warning, ...rest);
};

await import("../src/cli.ts");
