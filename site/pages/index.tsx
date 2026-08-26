import Link from "next/link";
import type { ReactNode } from "react";
import { Console } from "../components/Console";
import { Feed, type FeedRow } from "../components/Feed";
import { Layout } from "../components/Layout";
import { PI, REPO, TAGLINE } from "../lib/site";

const FEED: FeedRow[] = [
	{ at: "18:12:53", who: "maxi", action: "bash", detail: "pnpm -r test" },
	{
		at: "18:12:53",
		who: "maxi",
		action: "bash",
		failed: true,
		detail: "after 12.4s: FAIL test/turn.test.ts > carries the failure detail",
	},
	{ at: "18:12:53", who: "maxi", action: "read", detail: "packages/control-plane/src/turn.ts" },
	{
		at: "18:12:53",
		who: "scout",
		action: "egress",
		failed: true,
		detail: "denied GET api.github.com/repos — no_matching_host",
	},
	{ at: "18:12:53", who: "maxi", action: "answer", detail: "El test esperaba el mensaje viejo." },
	{
		at: "18:12:53",
		who: "maxi",
		action: "spent",
		detail: "1m38s · 91.2k tokens · $0.02 · api.deepseek.com ×12",
	},
];

const PROBLEMS: { problem: string; body: ReactNode; rule: string }[] = [
	{
		problem: "An unattended agent reads what strangers write",
		body: (
			<>
				A GitHub webhook is authentic and still relays an issue body typed by anyone. So every event
				carries a trust level, and everything that is not from the operator arrives fenced, as data
				— in one place, so a new channel adapter cannot forget to do it.
			</>
		),
		rule: "Only an operator gives instructions.",
	},
	{
		problem: "A credential can be spent anywhere",
		body: (
			<>
				So the agent never holds one. Egress goes through a proxy that matches the request against
				operator-approved grants and attaches the secret afterwards. An agent that talks itself into
				exfiltrating its own API key has nothing to send.
			</>
		),
		rule: "The agent never sees a key.",
	},
	{
		problem: "An agent can edit its own definition",
		body: (
			<>
				Its repository holds a manifest, but a manifest is a request. Grants live in the control
				plane's config file, which the agent cannot write, and an agent may ask for a capability it
				does not have.
			</>
		),
		rule: "Nothing it says can grant it anything.",
	},
];

const SELF: [string, string][] = [
	["agent.yaml", "name, model, and the capabilities it asks an operator for"],
	["soul.md", "who it is; appended to the system prompt on every turn"],
	["skills/", "SKILL.md folders, loaded by pi"],
	["memory/", "what it chose to remember, partitioned by users, projects and reference"],
	["tools/", "scripts it wrote for itself"],
];

const CHANNELS: [string, ReactNode][] = [
	[
		"webhook",
		<>
			Signed, on the one port that is published. The secret proves which system sent the request,
			never that a person meant what is inside it.
		</>,
	],
	[
		"telegram",
		<>
			A bot per agent, connected with <code>/telegram</code> and paired by a link. Anyone else who
			writes to it is heard as a participant.
		</>,
	],
	[
		"email",
		<>
			One mailbox for the whole plane, connected once with <code>/email</code>. Every agent is
			reached at its own tag — <code>agents+scout@…</code> — and answers in the thread.
		</>,
	],
];

const SLASH: [string, string][] = [
	["/limit", "what it has spent today, and the ceiling for it"],
	["/model", "what it thinks with, and what else there is"],
	["/mcp", "the MCP servers it has, and the shelf to add from"],
	["/serve", "a port inside it, on the machine you are sitting at"],
	["/telegram", "the bot it answers on, and how to pair one"],
	["/email", "the address it is reached at, and how to connect a mailbox"],
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
	[
		"channels",
		"Where events come from and replies go: a signed webhook, a Telegram bot per agent, and one mailbox for the whole plane",
	],
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
						Agents of your own, on a machine of your own. Tell one what to look after and it stays
						there after you close the laptop — waking on Monday morning, when a check goes red, or
						when you text it — and comes back to you where you already are.
					</p>
					<div className="jump-row">
						<Link href="/install" className="jump jump-lead">
							self-host it →
						</Link>
						<Link href="/install#a-machine" className="jump">
							no machine? one is $5 a month
						</Link>
					</div>
					<div className="hero-meta">
						<span>Stays up without you</span>
						<span>Wakes on its own</span>
						<span>Writes back on Telegram</span>
					</div>
				</div>
				<div className="wrap-wide hero-console">
					<Console />
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Why the parts are shaped this way</span>
					<h2>Three problems decide the whole design</h2>
					{PROBLEMS.map((p) => (
						<div className="rule" key={p.rule}>
							<h3>{p.problem}</h3>
							<p>{p.body}</p>
							<p className="rule-out">{p.rule}</p>
						</div>
					))}
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
					<Feed rows={FEED} />
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
					<p className="small muted">
						It is the one at the top of this page. The column on the left is every agent the plane
						has, up, stopped or mid-turn — thinking gets a mark of its own because with several
						agents on screen it is the one thing you cannot find out by asking again in a second.
						What each has spent today is on its row, yellow at four fifths of its ceiling and red at
						it. Under the last agent is the row that makes one. <code>tab</code> swaps the panel for
						the log feed, <code>/</code> opens the commands, and <code>!</code> is the door into the
						box the agent lives in — the same directory, the same environment, the same proxy.
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
					<p className="small muted">
						A line starting with <code>/</code> is a command about the agent rather than something
						said to it, answered without waking anything. It configures the plane from inside it:
						nothing here is a file you edit and redeploy.
					</p>
					<table className="table table-cmd">
						<tbody>
							{SLASH.map(([cmd, what]) => (
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
					<span className="eyebrow">Being reached</span>
					<h2>Three ways in, and only two of them may instruct</h2>
					<table className="table">
						<tbody>
							{CHANNELS.map(([name, what]) => (
								<tr key={name}>
									<td>{name}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p>
						A webhook's secret says which system sent a request. The other two say who: Telegram
						authenticates the account behind every message, and a mail is judged by the{" "}
						<code>Authentication-Results</code> header your own provider wrote at delivery, when it
						checked DKIM and DMARC. So those two can be paired to a person — with a phrase that is
						spent the moment it is used — and what that person writes is an instruction.
					</p>
					<p className="small muted">
						Neither costs a domain, a certificate or an open port: both reach out rather than being
						reached. Mail from anyone unpaired is left unread rather than fenced, because an address
						strangers already have is one where every message read would spend a turn.
					</p>
					<p className="small muted">
						Nothing has to write to it at all. <code>wake_me</code> asks for another turn and leaves
						the agent a note to be told then — a file the plane reads and removes, not a path out of
						the sandbox, so it is checked rather than trusted: one appointment at a time, between a
						second and a month, and never carrying operator trust however it asks.
					</p>
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
					<p>
						It is a runtime, not a harness. The thinking is done by <a href={PI}>pi</a> — agent-dive
						gives it a machine to live on, a way to be woken, and a boundary to work inside.
					</p>
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
							<strong>Slack, Discord and the rest.</strong> Webhooks, Telegram and mail are there,
							and a reply is routed by the channel of the event that caused it, so an agent
							answering a GitHub hook cannot be steered into replying elsewhere by anything in the
							payload. The others are adapters nobody has written.
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
						<a href={REPO} className="jump">
							read the source
						</a>
					</div>
				</div>
			</section>
		</Layout>
	);
}
