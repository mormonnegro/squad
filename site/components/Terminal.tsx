export function Terminal({ children }: { children: string }) {
	return (
		<div className="terminal">
			<pre>{children.replace(/^\n/, "").replace(/\s+$/, "")}</pre>
		</div>
	);
}
