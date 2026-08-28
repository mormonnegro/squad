import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

const SECTIONS: [string, string][] = [
	["models", "the providers this plane can pay, and what its agents think with"],
	["search", "where web_search goes, and what a search costs"],
	["grants", "the hosts the agents may reach, and what they carry"],
	["mcp", "the servers on the shelf, and which agents hold them"],
	["email", "the mailbox agents are reached at, and whose mail they read"],
];

export default function Config() {
	return (
		<Docs
			title="config.yaml"
			lede="Every capability an agent has is in one file, and no secret is. The file describing what an agent may reach should be committable and diffable, because a grant nobody noticed being added is the failure mode."
			description="The whole config surface, what it deliberately does not hold, and the store beside it that the console writes to."
		>
			<section>
				<span className="eyebrow">The surface</span>
				<h2>Five keys, and nothing you would not want in a diff</h2>
				<Code label="deploy/config.yaml">{`
stateDir: /var/lib/squad

models:                   # what there is to think with
defaults:                 # model, limitUsd, grants — and the whole of an agent made later
agents:                   # id, description, grants, schedules
hooks:                    # the signed endpoints, and which agent each reaches
`}</Code>
				<p>
					<code>deploy/config.example.yaml</code> is that surface written out with the reasons
					beside it. No secret is in any of it: it names environment variables and the process holds
					the values, so the file goes in git and a review of it is a review of what the agents can
					do.
				</p>
				<p className="small muted">
					<code>defaults</code> is the operator's answer, given in advance, to what an agent made at
					the keyboard may reach — because nothing said to an agent in a chat pane may widen it. An
					agent's own block adds to those rather than replacing them.
				</p>
			</section>

			<section>
				<span className="eyebrow">The screen beside it</span>
				<h2>Everything this plane can be given, in one place</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ Everything this plane can be given is here: the keys it pays   │
│ with, what its agents think with, where they search from,      │
│ everywhere they may reach, and the mailbox they are written    │
│ to at.                                                         │
│                                                                │
│ All of it is kept beside deploy/config.yaml rather than in it  │
│ — what that file declares is read here and changed only there  │
│ — and all of it holds from the next turn, with nothing         │
│ restarted.                                                     │
│                                                                │
│ ● models    the providers this plane can pay, and what its ag… │
│ ○ search    where web_search goes, and what a search costs     │
│ ● grants    the hosts the agents may reach, and what they car… │
│ ● mcp       the servers on the shelf, and which agents hold t… │
│ ○ email     the mailbox agents are reached at, and whose mai… │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ 3 to think with, 1 of 4 providers paid for                 │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<table className="table">
					<tbody>
						{SECTIONS.map(([name, what]) => (
							<tr key={name}>
								<td>{name}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p>
					Each row says what its section is for, because a column of bare nouns is a screen you have
					to open every row of to find the one you came here for. The line under the list is how
					that section actually stands — <code>1 of 4 providers paid for</code>, the address the
					mail comes to — which is the fact a row saying what it is for cannot carry, and is usually
					the reason you are here.
				</p>
				<p>
					There are two ways in. The column is one — the screen is its last row, so{" "}
					<code>shift-tab</code> from the first agent arrives in a single press — and{" "}
					<code>/config</code> is the other, typed from wherever the hand already is.{" "}
					<code>/config email</code> skips this list and lands in that section.
				</p>
			</section>

			<section>
				<span className="eyebrow">Which of the two wins</span>
				<h2>What the file declares is read here and changed only there</h2>
				<p>
					Everything given at the console lives in a store beside <code>config.yaml</code> and never
					in it, so the operator's file stays the operator's. A redeploy brings back what was
					written there, and what was typed here survives the redeploy on its own.{" "}
					<code>from the file</code> is a row the screen will not shadow and will not drop, and it
					says so rather than refusing after the fact.
				</p>
				<p>
					An edit to the file itself is read when the plane starts, so it takes hold on{" "}
					<code>docker compose restart control-plane</code> from <code>/opt/squad/deploy</code>.
					That is the road for the half the console has no box for — the credential on a grant — and
					it is the reason the console can widen where an agent goes and can never decide what it
					spends. <Link href="/docs/grants/">Reach</Link> is where that line is drawn.
				</p>
			</section>

			<section>
				<span className="eyebrow">The deployment</span>
				<h2>Three things that are load-bearing and easy to get wrong</h2>
				<p>
					The control plane runs <strong>on the agents' network</strong>, not on the host.
					Containers on an internal network cannot reach the host at all, so a proxy on the host is
					one the agents cannot use.
				</p>
				<p>
					The state directory is bind-mounted <strong>at its own path</strong>. The control plane
					hands the daemon that path when mounting the CA into a sandbox, and the daemon resolves
					bind sources on the host.
				</p>
				<p>
					A sandbox <strong>outlives the plane that made it</strong>, and its proxy credential is in
					its environment — so a restarting plane reads that credential back off the container
					rather than deciding it. A plane that decided instead would come back denying every
					request its own agents made, the model included, with the sandboxes looking perfectly
					healthy.
				</p>
				<p className="small muted">
					The control plane holds the Docker socket, so it is root-equivalent on the machine. The
					trust boundary is the sandbox around the agent, not the process managing it —{" "}
					<Link href="/docs/trust/">Trust</Link> says what that does and does not claim.
				</p>
			</section>
		</Docs>
	);
}
