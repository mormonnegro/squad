/**
 * What the console printed, verbatim. `Code` is for a line to be copied and run, and wears a button
 * that says so; this is a picture of something that already happened, which there is nothing to do
 * with but read.
 */
export function Screen({ children }: { children: string }) {
	return (
		<div className="terminal">
			<pre>{children.replace(/^\n+/, "").replace(/\s+$/, "")}</pre>
		</div>
	);
}
