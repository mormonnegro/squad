import type { ReactNode } from "react";
import { useCopy } from "../lib/copy";

// Enough colour to tell a typed command from its output, and no more. A highlighter that knew the
// language would be a dependency and a build step for two rules.
function paint(code: string): ReactNode[] {
	return code.split("\n").map((line, i) => {
		const key = `${i}`;
		const shell = /^(\s*)\$ (.*)$/.exec(line);
		if (shell) {
			return (
				<span key={key}>
					{shell[1]}
					<span className="prompt">$ </span>
					{shell[2]}
					{"\n"}
				</span>
			);
		}
		const whole = /^(\s*)(#.*)$/.exec(line);
		if (whole) {
			return (
				<span key={key}>
					{whole[1]}
					<span className="comment">{whole[2]}</span>
					{"\n"}
				</span>
			);
		}
		const trailing = /^(.*?)(\s{2,}#.*)$/.exec(line);
		if (trailing) {
			return (
				<span key={key}>
					{trailing[1]}
					<span className="comment">{trailing[2]}</span>
					{"\n"}
				</span>
			);
		}
		return <span key={key}>{`${line}\n`}</span>;
	});
}

export function Code({
	label,
	wrap,
	children,
}: {
	label?: string;
	// For a line too long to fit: wrapped rather than scrolled sideways, since what is copied is the
	// string and not what the column did to it.
	wrap?: boolean;
	children: string;
}) {
	const code = children.trim();
	const { done, copy } = useCopy(code);

	return (
		<div className="code" data-wrap={wrap ? "true" : undefined}>
			<div className="code-head">
				<span>{label ?? "sh"}</span>
				<button type="button" className="copy" data-done={done} onClick={copy}>
					{done ? "copied" : "copy"}
				</button>
			</div>
			<pre>
				<code>{paint(code)}</code>
			</pre>
		</div>
	);
}
