import Link from "next/link";
import { Console } from "../components/Console";
import { Layout } from "../components/Layout";
import { Terminal } from "../components/Terminal";
import { PI, REPO, TAGLINE } from "../lib/site";

const FEED = `
18:12:53  maxi      bash        pnpm -r test
18:12:53  maxi      bash      ✗ after 12.4s: FAIL test/turn.test.ts > carries the failure detail
18:12:53  maxi      read        packages/control-plane/src/turn.ts
18:12:53  scout     egress    ✗ denied GET api.github.com/repos — no_matching_host
18:12:53  maxi      answer      El test esperaba el mensaje viejo.
18:12:53  maxi      spent       1m38s · 91.2k tokens · $0.02 · api.deepseek.com ×12
`;

const SELF: [string, string][] = [
	["agent.yaml", "name, model, and the capabilities it asks an operator for"],
	["soul.md", "who it is; appended to the system prompt on every turn"],
	["skills/", "SKILL.md folders, loaded by pi"],
	["memory/", "what it chose to remember, partitioned by users, projects and reference"],
	["tools/", "scripts it wrote for itself"],
];

const COMMANDS: [string, string][] = [
	["agent chat demo", "talk to one in the scrollback, turn after turn"],
	["agent ls", "what each agent is and whether it is up"],
	['agent wake "check the open issues"', "take one turn, and wait for the answer"],
	["agent logs", "follow what every agent runs, answers and spends"],
	["agent rm demo --purge", "the sandbox, and with --purge the repository inside it"],
];

const PIECES: [string, string][] = [
	[
		"events",
		"Trust levels, fencing, the durable event bus, and the renderer that turns a batch of events into one turn",
	],
	[
		"proxy",
		"The egress broker: a CONNECT-terminating MITM proxy with a local CA, grant matching and credential injection",
	],
	[
		"sandbox",
		"The Docker driver: container per agent, named volume for its repository, exec streams demultiplexed from the daemon's framing",
	],
	[
		"scheduler",
		"Cron and one-shot wakeups, persisted, with Vixie cron semantics and DST-correct wall-clock matching",
	],
	["channels", "Where events come from and replies go. Ships a signed webhook channel"],
	["agent-repo", "The agent's own git repository: manifest, soul, skills, memory, tools"],
	[
		"control-plane",
		"Wires it together, takes turns by running pi in the sandbox, and reads a YAML config",
	],
];

export default function Home() {
	return (
		<Layout description={TAGLINE}>
			<section className="hero">
				<div className="wrap">
					<h1>agent-dive</h1>
					<p className="lede">
						Self-hosted cloud agents. An agent here is a container that stays running, wakes up when
						something happens, and reaches the outside world only through credentials it never sees.
					</p>
					<p className="muted">
						It is a runtime, not a harness. The thinking is done by <a href={PI}>pi</a> — agent-dive
						gives it a machine to live on, a way to be woken, and a boundary to work inside.
					</p>
					<div className="jump-row">
						<Link href="/install" className="jump">
							install it →
						</Link>
						<a href={REPO} className="jump">
							read the source
						</a>
					</div>
					<div className="hero-meta">
						<span>Docker and Node 22</span>
						<span>One VPS is enough</span>
						<span>MIT</span>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Why the parts are shaped this way</span>
					<h2>Three problems decide the whole design</h2>
				</div>
				<div className="wrap-wide">
					<div className="cards cards-3">
						<div className="card">
							<h3>An agent that runs unattended will eventually read something a stranger wrote</h3>
							<p>
								A GitHub webhook is authentic and still relays an issue body typed by anyone. So
								every event carries a trust level, and only <code>operator</code> events are
								rendered as instructions.
							</p>
							<p>
								Everything else is fenced and introduced as data, in one place, so a new channel
								adapter cannot forget to do it.
							</p>
						</div>
						<div className="card">
							<h3>An agent with a credential can spend it anywhere</h3>
							<p>
								So it never holds one. Egress goes through a proxy that matches the request against
								operator-approved grants and attaches the secret afterwards.
							</p>
							<p>
								The model included: an agent that talks itself into exfiltrating its own API key has
								nothing to send.
							</p>
						</div>
						<div className="card">
							<h3>An agent that can edit its own definition can grant itself capabilities</h3>
							<p>
								The agent repository holds a manifest, but a manifest is a request. Grants live in
								the control plane's config file, which the agent cannot write.
							</p>
							<p>A keyboard may name an agent. A keyboard may never grant one.</p>
						</div>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">The boundary</span>
					<h2>The only road out is the proxy</h2>
					<p>
						The sandbox network is <code>internal</code>, which really is unrouted — a container on
						it cannot reach the host or the internet by any address. So the proxy is not a
						convenience the agent could route around, and reaching the model provider is a grant
						like any other, written onto the request on its way out.
					</p>
					<p>
						A request that was denied, or came back 401 or 429, is said the moment it happens,
						because it is the reason the agent is about to misbehave. The ones that worked are
						counted rather than printed.
					</p>
				</div>
				<div className="wrap-wide">
					<Terminal>{FEED}</Terminal>
					<p className="caption">
						<code>agent logs</code> — what every agent runs, answers and spends.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Driving it</span>
					<h2>One control surface, and it is a terminal</h2>
					<p>
						A running plane listens on a unix socket in its state directory. There is no password
						because there is nothing to authenticate: the socket is <code>0600</code>, and reaching
						it already means holding a file the operator owns. That is also why it is the only way
						in that carries operator trust.
					</p>
					<p>
						<code>agent</code> on its own opens the console, because someone typing the command with
						nothing after it is asking to see the thing, not to be told a fact about it.
					</p>
				</div>
				<div className="wrap-wide">
					<Console />
				</div>
				<div className="wrap">
					<p className="small muted">
						The column on the left is every agent the plane has, up, stopped or mid-turn — thinking
						gets a mark of its own because with several agents on screen it is the one thing you
						cannot find out by asking again in a second. What each has spent today is on its row,
						yellow at four fifths of its ceiling and red at it. Under the last agent is the row that
						makes one. <code>tab</code> swaps the panel for the log feed, <code>/</code> opens the
						commands, and <code>!</code> is the door into the box the agent lives in — the same
						directory, the same environment, the same proxy.
					</p>
					<table className="table table-cmd">
						<tbody>
							{COMMANDS.map(([cmd, what]) => (
								<tr key={cmd}>
									<td>{cmd}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">What an agent is made of</span>
					<h2>A repository it owns</h2>
					<p>
						On its first boot an agent gets a repository in its own volume, at{" "}
						<code>/home/agent/.self</code>:
					</p>
					<table className="table">
						<tbody>
							{SELF.map(([file, what]) => (
								<tr key={file}>
									<td>{file}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p>
						It is scaffolded once, git-initialised, and then left alone: turns run inside it, so
						what the agent learns and what it can do are files it edits and commits itself. The
						control plane never writes there again, because the second write would be the control
						plane overwriting the agent's own work.
					</p>
					<p className="muted">
						Nothing in that repository grants anything. <code>agent.yaml</code> lists capability{" "}
						<em>requests</em>, and an operator answers them in the config file the agent cannot
						reach.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">The pieces</span>
					<h2>Seven packages, no build step</h2>
					<table className="table">
						<tbody>
							{PIECES.map(([name, what]) => (
								<tr key={name}>
									<td>{name}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">What is deliberately missing</span>
					<h2>The honest list</h2>
					<ul className="list">
						<li>
							<strong>A long-lived pi session.</strong> Each wakeup runs <code>pi --print</code>{" "}
							against a per-agent session directory, so context carries across turns but the process
							does not. The plumbing for a persistent session is written and tested, and unused,
							because the published pi has no server entry point to run yet.
						</li>
						<li>
							<strong>Channels other than webhooks.</strong> The interface and the router are there,
							and a reply is routed by the channel of the event that caused it. Slack, email and the
							rest are adapters that do not exist yet.
						</li>
						<li>
							<strong>Anything multi-tenant.</strong> One config file, one operator, one machine.
						</li>
						<li>
							<strong>Isolation stronger than a container.</strong> One Docker container per agent,
							not a microVM — because if self-hosting needed microVMs nobody would run it. It is not
							a boundary to put hostile code inside.
						</li>
					</ul>
					<div className="jump-row">
						<Link href="/install" className="jump">
							put it on a VPS →
						</Link>
					</div>
				</div>
			</section>
		</Layout>
	);
}
