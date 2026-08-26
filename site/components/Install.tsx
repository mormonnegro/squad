import { useCopy } from "../lib/copy";
import { PACKAGE } from "../lib/site";

const COMMAND = `npx ${PACKAGE}`;

/**
 * The install, which is one command.
 *
 * It was two, and both of them were a hundred-character URL — the first thing on the page was the
 * ugliest thing on it, and it read as a procedure rather than a product. There is still a procedure
 * underneath and it is still two shell scripts; this is the line that knows where they go.
 */
export function Install() {
	const { done, copy } = useCopy(COMMAND);

	return (
		<div className="start">
			<div className="start-cmd">
				<pre>
					<span className="prompt">$ </span>
					{COMMAND}
				</pre>
				<button type="button" className="copy" data-done={done} onClick={copy}>
					{done ? "copied" : "copy"}
				</button>
			</div>
			<p className="start-then">
				Run it on your own computer. It installs on the machine you name, over the SSH you already
				have to it, and leaves <code>agent</code> here as its console.
			</p>
		</div>
	);
}
