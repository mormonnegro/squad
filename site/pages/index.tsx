import Link from "next/link";
import type { ReactNode } from "react";
import { Code } from "../components/Code";
import { Console } from "../components/Console";
import { Feed, type FeedRow } from "../components/Feed";
import { Layout } from "../components/Layout";
import { Screen } from "../components/Screen";
import { CLIENT, REPO, TAGLINE } from "../lib/site";

const FEED: FeedRow[] = [
	{ at: "18:12:53", who: "builds", action: "bash", detail: "pnpm -r test" },
	{
		at: "18:12:53",
		who: "builds",
		action: "bash",
		failed: true,
		detail: "after 12.4s: FAIL test/turn.test.ts > carries the failure detail",
	},
	{ at: "18:12:53", who: "builds", action: "read", detail: "packages/control-plane/src/turn.ts" },
	{
		at: "18:12:53",
		who: "tickets",
		action: "egress",
		failed: true,
		detail: "denied GET api.github.com/repos — no_matching_host",
	},
	{ at: "18:12:53", who: "builds", action: "answer", detail: "The test asserted the old message." },
	{
		at: "18:12:53",
		who: "builds",
		action: "spent",
		detail: "1m38s · 91.2k tokens · $0.02 · api.deepseek.com ×12",
	},
];

// What somebody actually hands one, in the words they would use for it. Every line is a standing job
// rather than a demo: the question this page answers first is what a person would keep one for.
const JOBS: [string, ReactNode][] = [
	[
		"watch a repo",
		<>
			A check goes red. It reads the failure, fixes it, pushes, and says what it did on the pull
			request — while you were at lunch.
		</>,
	],
	[
		"track a rival",
		<>Monday at eight: three pricing pages, three changelogs. One mail, and it is what moved.</>,
	],
	[
		"a long errand",
		<>
			<em>Deploy when CI goes green</em> is not one turn. It checks, books itself another turn, and
			writes when it is live.
		</>,
	],
	[
		"keep watch",
		<>
			A URL every ten minutes, a certificate that expires. The message arrives from a machine that
			is not the one that went down.
		</>,
	],
	[
		"a desk to ask at",
		<>
			Mail it, or message its bot from the airport. It has the repository, the tools and four months
			of what you told it.
		</>,
	],
];

const SELF: [string, string][] = [
	["soul.md", "who it is; added to the prompt every turn"],
	["memory/", "what it chose to remember"],
	["skills/", "how things are done here, written down once"],
	["tools/", "scripts it wrote for itself"],
	["agent.yaml", "the capabilities it asks an operator for"],
];

const CHANNELS: [string, ReactNode][] = [
	[
		"email",
		<>
			One mailbox for the whole plane, connected with <code>/email</code>. Every agent has its own
			address in it — <code>agents+scout@…</code> — and answers in the thread.
		</>,
	],
	[
		"telegram",
		<>
			A bot per agent: a token into <code>/telegram</code>, and your phone is where the one-line
			errands get typed.
		</>,
	],
	[
		"webhook",
		<>For systems rather than people: GitHub, a deploy, anything that can sign a request.</>,
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
	["squad chat demo", "talk to one in the scrollback, turn after turn"],
	["squad ls", "what each agent is and whether it is up"],
	['squad wake "check the open issues"', "take one turn, and wait for the answer"],
	["squad logs", "follow what every agent runs, answers and spends"],
	["squad rm demo --purge", "the sandbox, and with --purge the repository inside it"],
];

const PROBLEMS: { problem: string; body: ReactNode; rule: string }[] = [
	{
		problem: "An unattended agent reads what strangers write",
		body: (
			<>
				A GitHub webhook is authentic and still relays an issue body typed by anyone. Everything
				that did not come from you arrives fenced, as data.
			</>
		),
		rule: "Only an operator gives instructions.",
	},
	{
		problem: "A credential can be spent anywhere",
		body: (
			<>
				So the agent never holds one. What it reaches for goes out through a proxy that checks the
				request against what you approved and attaches the secret afterwards. An agent talked into
				sending you its API key has nothing to send.
			</>
		),
		rule: "The agent never sees a key.",
	},
	{
		problem: "An agent can edit its own definition",
		body: (
			<>
				It owns its repository, and a line in it is a request. What it may reach is answered in a
				file it cannot write.
			</>
		),
		rule: "Nothing it says can grant it anything.",
	},
];

export default function Home() {
	return (
		<Layout description={TAGLINE}>
			<section className="hero">
				<div className="wrap">
					<h1>squad</h1>
					<p className="lede">{TAGLINE}</p>
					<div className="hero-install">
						<Code label="on your laptop" wrap>{`
$ curl -fsSL ${CLIENT} | sh
$ squad
`}</Code>
						<p className="small muted">
							You choose where the agents live: on your own computer, or in the cloud. It is the
							first thing it asks — this machine, or a server you have SSH to. A $5 VPS is enough
							for a few of them.
						</p>
					</div>
				</div>
				<div className="wrap-wide hero-console">
					<Console />
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">What you keep one for</span>
					<h2>A standing job, and it goes and does it</h2>
					<table className="table">
						<tbody>
							{JOBS.map(([job, what]) => (
								<tr key={job}>
									<td>{job}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="small muted">
						One agent per job — the column on the left of that console. Making the next one is a
						name and <code>⏎</code>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Where it works</span>
					<h2>Its own machine, and root on it</h2>
					<p>
						Every agent gets a box of its own. It can pull down a toolchain at three in the morning,
						run your test suite forty times and fill the disk with a bad build — your laptop is not
						in the blast radius, and neither is the agent next door. That is what makes it worth
						handing real work: it does not describe the fix, it makes the fix and runs the tests.
					</p>
					<p>
						Two things outlive the container. <code>~/workspace</code> holds your projects, and{" "}
						<code>~/.self</code> is the agent itself — a git repository it owns:
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
						<code>tools/</code> is the one to look at twice. An agent that shelled out to something
						awkward three times writes itself a script for the fourth, and is better at your work on
						Friday than it was on Monday.
					</p>
					<p className="small muted">
						<code>!</code> opens a shell in that same box, and <code>/serve 3000</code> brings a
						port out of it onto the machine your browser is on.{" "}
						<Link href="/docs/agents/">Agents</Link> is the long version.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">While you are asleep</span>
					<h2>It books its own next turn, and the day has a ceiling</h2>
					<p>
						Two clocks. One you wrote — cron, in a time zone you name. One it sets itself:{" "}
						<code>wake_me</code> asks for another turn in three minutes or three days and leaves a
						note for the version of itself that wakes up. That is why a long job is something you
						can hand over rather than sit through.
					</p>
					<Screen>{`
> /limit 5
Spending limit set to $5.00 a day. $0.42 spent today, of $5.00 a day.
`}</Screen>
					<p>
						An agent running with nobody watching has a ceiling in dollars a day. Reaching it stops
						the next turn rather than the one in flight. An agent may ask to be held to less; it
						gets nowhere asking for more.
					</p>
					<p className="small muted">
						What it thinks with is a command and not a redeploy. The key is yours and the bill is
						your provider's — there is no account here to hold either.{" "}
						<Link href="/docs/schedules/">Schedules</Link>,{" "}
						<Link href="/docs/limits/">spending</Link> and <Link href="/docs/models/">models</Link>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Being reached</span>
					<h2>It has an address and a phone</h2>
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
						A reply goes back the way the ask came in. Telegram and mail can be paired to a person,
						and what that person writes is an instruction. Everyone else is heard, quoted, and not
						obeyed.
					</p>
					<p className="small muted">
						None of the three costs a domain, a certificate or an open port.{" "}
						<Link href="/docs/email/">Email</Link>, <Link href="/docs/telegram/">Telegram</Link> and{" "}
						<Link href="/docs/webhooks/">webhooks</Link>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Tools</span>
					<h2>Give it Linear without giving it the key</h2>
					<Screen>{`
> /mcp add linear https://mcp.linear.app/mcp
"linear" is on the shelf, and this agent has it.

Any other agent can have it too, with /mcp linear.
`}</Screen>
					<p>
						One line, and on its next turn the agent has Linear's tools registered as its own. MCP
						servers go on a shelf the plane keeps, so every agent after the first is a name off a
						list.
					</p>
					<p>
						A server that wants an account is logged into from the console, and the token that comes
						back stays on the plane. What the agent gets is the tool; what it never gets is the
						secret.
					</p>
					<p className="small muted">
						<Link href="/docs/mcp/">MCP servers</Link>, and{" "}
						<Link href="/docs/search/">web search</Link>, which is one granted endpoint and the
						reading done on the far side of it.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Driving it</span>
					<h2>One screen, and it is a terminal</h2>
					<p>
						<code>squad</code> on its own opens the console at the top of this page: every agent on
						the left, the conversation on the right, <code>tab</code> for the log feed,{" "}
						<code>/</code> for the commands and <code>!</code> for the shell inside the box.
					</p>
					<p>
						A key, a model, a mailbox, an MCP server, a ceiling — everything is set from in there,
						and holds from the next turn with nothing restarted.
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
					<p className="small muted">
						And it is a program on your PATH, so the parts of it that belong in a script are a
						script. <Link href="/docs/console/">The console</Link> has every key and every command.
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
					<span className="eyebrow">Seeing what happened</span>
					<h2>Every turn says what it ran, what it answered and what it cost</h2>
					<p>
						A request that was refused, or came back 401, is said the moment it happens. The hundred
						that worked are counted rather than printed.
					</p>
				</div>
				<div className="wrap-wide">
					<Feed rows={FEED} />
					<p className="caption">
						<code>squad logs</code> — what every agent runs, answers and spends.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">The bounds</span>
					<h2>Three rules it cannot talk its way past</h2>
					{PROBLEMS.map((p) => (
						<div className="rule" key={p.rule}>
							<h3>{p.problem}</h3>
							<p>{p.body}</p>
							<p className="rule-out">{p.rule}</p>
						</div>
					))}
					<p className="small muted">
						The sandbox network is unrouted, so the proxy is not a convenience it could route around
						— even reaching the model provider is an approval.{" "}
						<Link href="/docs/trust/">Trust</Link> and <Link href="/docs/grants/">reach</Link> are
						where that is spelled out.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">What is deliberately missing</span>
					<h2>The honest list</h2>
					<ul className="list">
						<li>
							<strong>Slack, Discord and the rest.</strong> Mail, Telegram and webhooks are there.
							The others are adapters nobody has written yet.
						</li>
						<li>
							<strong>Anything multi-tenant.</strong> One config file, one operator, one machine.
						</li>
						<li>
							<strong>Isolation stronger than a container.</strong> One Docker container per agent,
							not a microVM — because if self-hosting needed microVMs nobody would run it.
						</li>
						<li>
							<strong>A hosted anything.</strong> No account, no dashboard and no bill from us. You
							bring a machine and a model key, and what it costs is what your provider charges.
						</li>
					</ul>
					<div className="jump-row">
						<Link href="/install" className="jump">
							put it on a VPS →
						</Link>
						<Link href="/docs" className="jump">
							read the docs
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
