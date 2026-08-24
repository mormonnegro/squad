// The console drawn as elements rather than as the box-drawing capture from the README. The same
// picture pasted into a browser goes ragged: a proportional fallback for ● ◐ ○ is a cell and a half
// wide and every border after it moves.

const AGENTS: {
	name: string;
	state: "up" | "thinking" | "stopped";
	spend?: string;
	wait?: string;
}[] = [
	{ name: "demo", state: "up", spend: "$0.42" },
	{ name: "maxi", state: "thinking", spend: "$4.80", wait: "15m" },
	{ name: "scout", state: "stopped" },
];

const KEYS: [string, string][] = [
	["↑↓", "agent"],
	["^U^D", "scroll"],
	["tab", "logs"],
	["/", "commands"],
	["!", "shell"],
	["^C", "quit"],
];

export function Console() {
	return (
		<div className="mock">
			<div className="mock-frame">
				<div className="mock-side">
					<div className="mock-side-head">agents</div>
					{AGENTS.map((a) => (
						<div key={a.name} className="mock-agent" data-state={a.state}>
							<span className="mock-dot" aria-hidden="true" />
							<span className="mock-name">{a.name}</span>
							{a.wait ? <span className="mock-wait">{a.wait}</span> : null}
							{a.spend ? <span className="mock-spend">{a.spend}</span> : null}
						</div>
					))}
					<div className="mock-agent mock-new">
						<span className="mock-plus">+</span>
						<span className="mock-name">new agent</span>
					</div>
				</div>

				<div className="mock-main">
					<div className="mock-title">
						<span>
							<b>demo</b> chat · logs
						</span>
						<span className="mock-title-right">
							deepseek-v4-flash <span className="mock-spend">$0.42 / $5.00</span>
						</span>
					</div>
					<div className="mock-body">
						<p className="mock-said">&gt; que es un webhook</p>
						<p>
							Un webhook es una forma de comunicación automática entre servicios: cuando ocurre un
							evento en un sistema, ese sistema envía una petición HTTP a una URL configurada.
						</p>
					</div>
					<div className="mock-prompt">&gt;</div>
				</div>
			</div>
			<div className="mock-keys">
				{KEYS.map(([key, label]) => (
					<span key={label}>
						<kbd>{key}</kbd> {label}
					</span>
				))}
			</div>
		</div>
	);
}
