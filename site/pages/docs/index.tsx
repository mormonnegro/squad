import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";
import { DOC_PAGES, DOCS } from "../../lib/docs";
import { CLIENT, PI, SITE } from "../../lib/site";

const WHERE: [string, string][] = [
	[
		"the console",
		"A slash command or the config screen. Keys, models, hosts, MCP servers, the mailbox and a ceiling, all holding from the next turn with nothing restarted.",
	],
	[
		"config.yaml",
		"The operator's file, on the machine the plane is on, which no plane may write: agents, schedules, webhooks, and every credential attached to a host by name.",
	],
	[
		"the repository",
		"Inside the agent's own volume: who it is, what it remembers, the skills it loaded and the tools it wrote for itself. Its own to edit, and nothing else's.",
	],
];

export default function DocsIndex() {
	return (
		<Docs
			title="Overview"
			lede="An agent here is a container that stays running, wakes up when something happens, and reaches the outside world only through credentials it never sees."
			description="What squad is, what an agent is made of, and where every setting lives: the console, the config file, and the agent's own repository."
		>
			<section>
				<span className="eyebrow">The shape of it</span>
				<h2>Two halves, and one question between them</h2>
				<p>
					There is the console you type at, and the plane the agents live in. You install the
					console on the computer you are sitting at, and the first run asks the one question the
					halves differ on: whether the agents should live <strong>here</strong>, or{" "}
					<strong>on a server</strong> you have SSH to.
				</p>
				<Code label="on your laptop" wrap>{`
$ curl -fsSL ${CLIENT} | sh
$ squad
`}</Code>
				<p className="small muted">
					Node 22.18 or newer, and nothing else on this computer — no Docker here whichever answer
					you give. <Link href="/install">The install page</Link> is the long version, including the
					same thing done by hand.
				</p>
				<p>
					Everything after that question is the same program. A plane answers the same protocol
					whether its socket is in a directory here or at the far end of{" "}
					<code>ssh vps squad relay</code>, so the agent list, the log feed, the conversation and a
					port forwarded out of a sandbox all run on this computer and reach the agents wherever
					they are.
				</p>
				<p className="small muted">
					It is a runtime rather than a harness. The thinking is done by <a href={PI}>pi</a>; squad
					gives it a machine to live on, a way to be woken, and a boundary to work inside.
				</p>
			</section>

			<section>
				<span className="eyebrow">The first five minutes</span>
				<h2>Type its name, and make one</h2>
				<p>
					<code>squad</code> with nothing after it opens the console, because someone typing the
					command with nothing after it is asking to see the thing rather than to be told a fact
					about it. With no agents at all it opens on the one row there is:
				</p>
				<Screen>{`
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ new agent                                                      │
│                      ││                                                                │
│ + new agent          ││ A name, and ⏎ builds it: a container, a repository of its own, │
│                      ││ nothing in its memory, and exactly what defaults in the config │
│ logs                 ││ allows it to reach.                                            │
│ config               ││                                                                │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│ ↑↓ moves             ││ │ name  scout                                                │ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ agents   ⏎ build   ^C quit
`}</Screen>
				<p>
					The name is the whole of what the keyboard decides there. What the new agent may reach is{" "}
					<code>defaults</code> in the config, answered in advance by whoever wrote that file —
					because the one thing a keyboard may never do here is grant. Then you talk to it, and it
					takes a turn.
				</p>
				<p className="small muted">
					<Link href="/docs/console/">The console</Link> is every key and every command on that
					screen. <Link href="/docs/agents/">Agents</Link> is what one turns out to be made of.
				</p>
			</section>

			<section>
				<span className="eyebrow">Before you go looking</span>
				<h2>Three places a setting lives</h2>
				<p>
					Nearly every question that starts "where do I put…" is answered by which of these three it
					belongs to, and they are told apart by who may write them.
				</p>
				<table className="table">
					<tbody>
						{WHERE.map(([where, what]) => (
							<tr key={where}>
								<td>{where}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					The console keeps what it is given in a store beside <code>config.yaml</code> and never in
					it, so the operator's file stays the operator's: what a redeploy brings back is what was
					written there, and what was typed at the console survives the redeploy on its own.
				</p>
			</section>

			<section>
				<span className="eyebrow">Everything there is</span>
				<h2>The map</h2>
				{DOCS.map((group) => (
					<div className="docs-map" key={group.name}>
						<h3>{group.name}</h3>
						<table className="table">
							<tbody>
								{group.pages.map((page) => (
									<tr key={page.href}>
										<td>
											<Link href={page.href}>{page.title}</Link>
										</td>
										<td>{page.blurb}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				))}
			</section>

			<section>
				<span className="eyebrow">Reading this without a browser</span>
				<h2>One address hands an agent the whole of it</h2>
				<p>
					Every page here is also written as markdown at the same address with <code>.md</code> on
					the end, and all {DOC_PAGES.length} of them are in one file. That file is the thing to
					paste when what you are explaining squad to is a coding agent rather than a person:
				</p>
				<Code label="the whole documentation" wrap>{`
${SITE}/llms-full.txt
`}</Code>
				<p className="small muted">
					<a href="/llms.txt">/llms.txt</a> is the index instead — the same list as the map above,
					with a link to each page's markdown, for a reader that would rather fetch the one page it
					needs. Both are converted from these pages at build time rather than written beside them,
					so neither can be a version behind what you are reading now.
				</p>
			</section>
		</Docs>
	);
}
