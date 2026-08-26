import type { ReactNode } from "react";
import { useCopy } from "../lib/copy";
import { CONNECT, INSTALL } from "../lib/site";

// The whole path from a bare machine to a console, in the order it is typed. On the front page
// rather than a link away, because "how do I run this" is the second question and it has a
// two-line answer.
const STEPS: { where: string; command: string; leaves: ReactNode }[] = [
	{
		where: "on your VPS",
		command: `curl -fsSL ${INSTALL} | sh`,
		leaves: (
			<>
				Installs Docker if the machine has none, asks for the keys the proxy will hold, and leaves{" "}
				<code>agent</code> on the PATH.
			</>
		),
	},
	{
		where: "on your laptop",
		command: `curl -fsSL ${CONNECT} | sh`,
		leaves: (
			<>
				Leaves <code>agent</code> there too. The first one asks which machine your plane is on and
				remembers it; every one after it is the console.
			</>
		),
	},
];

function Step({
	n,
	where,
	command,
	leaves,
}: {
	n: number;
	where: string;
	command: string;
	leaves: ReactNode;
}) {
	const { done, copy } = useCopy(command);

	return (
		<div className="install-step">
			<div className="install-head">
				<span className="install-n">{String(n).padStart(2, "0")}</span>
				<span className="install-where">{where}</span>
				<button type="button" className="copy" data-done={done} onClick={copy}>
					{done ? "copied" : "copy"}
				</button>
			</div>
			<pre className="install-cmd">
				<span className="prompt">$ </span>
				{command}
			</pre>
			<p className="install-then">{leaves}</p>
		</div>
	);
}

export function Install() {
	return (
		<div className="install">
			{STEPS.map((step, i) => (
				<Step key={step.where} n={i + 1} {...step} />
			))}
		</div>
	);
}
