import { spawn } from "node:child_process";

/**
 * The programs that own the clipboard, in the order worth trying.
 *
 * Wayland before X, because a Wayland session usually still has `xclip` on it and `xclip` on a
 * Wayland session copies into a selection nothing will ever paste from.
 */
export const KEEPERS: Readonly<Record<string, readonly (readonly string[])[]>> = {
	darwin: [["pbcopy"]],
	linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
	win32: [["clip"]],
};

/**
 * The sequence that asks the terminal itself to hold the text, for when no program here can.
 *
 * This is the only way that works from the far end of an `ssh`, where `pbcopy` would copy onto a
 * machine nobody is sitting at. Terminals that do not understand it drop it, which is why it is the
 * fallback and not the first choice: nothing comes back to say whether it landed.
 */
export function osc52(text: string): string {
	return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

/** Hands the text to one program, and says whether it took it. */
async function handed(text: string, argv: readonly string[]): Promise<boolean> {
	const [command = "", ...args] = argv;
	return await new Promise<boolean>((settle) => {
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", () => settle(false));
		child.on("close", (code) => settle(code === 0));
		// A clipboard program that is not installed fails on spawn rather than on the pipe, and the
		// write would then land on a stdin nobody is holding.
		child.stdin.on("error", () => {});
		child.stdin.end(text);
	});
}

/**
 * Puts the text on the clipboard, by whatever means this machine has.
 *
 * Returns whether a program took it. False is not the same as failure — the caller writes the
 * escape sequence instead — but it is the difference between knowing and hoping.
 */
export async function copied(text: string, platform: string = process.platform): Promise<boolean> {
	for (const argv of KEEPERS[platform] ?? []) {
		if (await handed(text, argv)) return true;
	}
	return false;
}
