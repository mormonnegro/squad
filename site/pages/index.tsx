import Link from "next/link";
import type { ReactNode } from "react";
import { Code } from "../components/Code";
import { Console } from "../components/Console";
import { Feed, type FeedRow } from "../components/Feed";
import { Layout } from "../components/Layout";
import { Screen } from "../components/Screen";
import { CLIENT, REPO, TAGLINE } from "../lib/site";

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

// What somebody actually hands one, in the words they would use for it. Every line is a standing job
// rather than a demo: the question this page answers first is what a person would keep one for.
const JOBS: [string, ReactNode][] = [
	[
		"watch a repo",
		<>
			A check goes red on a pull request. It reads the failure, fixes it, pushes to the branch and
			says what it did on the pull request — while you were at lunch.
		</>,
	],
	[
		"track a rival",
		<>
			Every Monday at eight, three pricing pages and three changelogs against what it wrote down
			last week. You get one mail, and it is the two lines that moved.
		</>,
	],
	[
		"a long errand",
		<>
			<em>Deploy when CI goes green</em> is not one turn. It checks, books itself another turn,
			checks again, and writes to you when it is live — an hour later, or tomorrow.
		</>,
	],
	[
		"keep watch",
		<>
			A URL every ten minutes, a queue that should not grow, a certificate that expires. The message
			arrives from a machine that is not the one that went down.
		</>,
	],
	[
		"a desk to ask at",
		<>
			Mail it, or message its bot from a queue at the airport. It has the repository, the tools and
			four months of what you told it, and it answers in the thread you asked in.
		</>,
	],
];

const SELF: [string, string][] = [
	["soul.md", "who it is; appended to the system prompt on every turn"],
	["memory/", "what it chose to remember, partitioned by users, projects and reference"],
	["skills/", "how to do the things you do here, written down once"],
	["tools/", "scripts it wrote for itself, and uses instead of working it out again"],
	["agent.yaml", "the capabilities it asks an operator for"],
];

const CHANNELS: [string, ReactNode][] = [
	[
		"email",
		<>
			One mailbox for the whole plane, connected once with <code>/email</code>. Every agent has its
			own address in it — <code>agents+scout@…</code> — and answers in the thread. No domain, no DNS
			record, no port to open.
		</>,
	],
	[
		"telegram",
		<>
			A bot per agent: two messages to BotFather, the token into <code>/telegram</code>, and your
			phone is where the one-line errands get typed. Paired to you by a phrase, so it is you it
			takes instructions from.
		</>,
	],
	[
		"webhook",
		<>
			For systems rather than people. GitHub, a deploy, anything that can sign a request — and what
			a stranger typed into the issue body arrives quoted, never as something to do.
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
				A GitHub webhook is authentic and still relays an issue body typed by anyone. So everything
				that did not come from you arrives fenced, as data — in one place, so a new channel cannot
				forget to do it.
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
				It owns its repository, and a line in it is a request. What an agent may reach is answered
				in a file it cannot write, so it may ask for a capability and get nowhere by asking.
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
						<p className="small">
							It asks one question: where the agents should live. <strong>On this computer</strong>,
							or <strong>on a server</strong> you have SSH to — it installs itself there over the
							connection you already have. The console you type at stays here either way.
						</p>
						<p className="small muted">
							Node 22.18 or newer, and nothing else. <Link href="/install">What it does</Link>, and
							if you have no server yet, <Link href="/install#a-machine">one is $5 a month</Link>.
						</p>
					</div>
					<div className="hero-meta">
						<span>A machine each</span>
						<span>Wakes on its own</span>
						<span>Mails and messages you back</span>
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
						One agent per job, which is what the column on the left of that console is: five of
						them, each with its own machine, its own memory of the work and its own ceiling on the
						day. Making the next one is a name and <code>⏎</code>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Where it works</span>
					<h2>Its own machine, and root on it</h2>
					<p>
						Every agent gets a box of its own — its own filesystem, its own processes, its own
						installed packages. It can pull down a toolchain at three in the morning, run your test
						suite forty times, fill the disk with a bad build and clear it again. Your laptop is not
						in the blast radius and neither is the agent next door.
					</p>
					<p>
						That is what makes it worth handing real work. It does not describe the fix, it makes
						the fix and runs the tests; it does not suggest a script, it writes the script,
						discovers the flag was wrong, and fixes it before telling you anything.
					</p>
					<p>
						Two things outlive the container. <code>~/workspace</code> is the desk it keeps your
						projects on, and <code>~/.self</code> is the agent itself — a git repository it owns:
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
						awkward three times writes itself a script for the fourth, commits it, and is better at
						your work on Friday than it was on Monday. That repository is scaffolded once and then
						left alone: what it learns and what it can do are files it edits itself, and nothing
						here writes over them.
					</p>
					<p className="small muted">
						<code>!</code> opens a shell in that same box — same directory, same environment, same
						reach — because the way to find out what an agent is looking at is to stand where it is
						standing. And <code>/serve 3000</code> brings a port out of there onto the machine your
						browser is on, so the thing it built is a link you click.{" "}
						<Link href="/docs/agents/">Agents</Link> is the long version.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">While you are asleep</span>
					<h2>It books its own next turn, and the day has a ceiling</h2>
					<p>
						Two clocks. One you wrote — cron, in a time zone you name, so nine in the morning is
						nine in the morning on both sides of a daylight-saving change. One it sets itself:{" "}
						<code>wake_me</code> asks for another turn in three minutes or three days and leaves a
						note for the version of itself that wakes up.
					</p>
					<p>
						That second one is why a long job is something you can hand over rather than sit
						through. Work that does not fit in one sitting used to end when the turn did. Now it
						checks, waits, checks again, and the thing you hear is the answer.
					</p>
					<p>
						And because an agent that wakes itself is an agent running with nobody watching, every
						one of them has a ceiling in dollars a day:
					</p>
					<Screen>{`
> /limit 5
Spending limit set to $5.00 a day. $0.42 spent today, of $5.00 a day.
`}</Screen>
					<p>
						Reaching it stops the next turn rather than the one in flight, and whatever arrives
						meanwhile is written down and answered when the day turns over. An agent may ask to be
						held to less; it gets nowhere asking for more. What each has spent today is on its row
						in the column, yellow at four fifths and red at it — before it is a question anybody
						thinks to ask.
					</p>
					<p className="small muted">
						What it thinks with is a command and not a redeploy, so the standing job that runs every
						morning can be on something cheap and the work you are watching on something good. The
						key is yours and the bill is your provider's — there is no account here to hold either.{" "}
						<Link href="/docs/schedules/">Schedules</Link>,{" "}
						<Link href="/docs/limits/">spending</Link> and <Link href="/docs/models/">models</Link>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Being reached</span>
					<h2>It has an address and a phone</h2>
					<p>
						An agent that only exists inside a terminal is one you have to remember to go and open.
						These are how it reaches you instead, and how you reach it from the queue at the
						airport.
					</p>
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
						A reply goes back the way the ask came in, so an agent answering a GitHub hook cannot be
						talked into replying somewhere else by something in the payload. Telegram and mail can
						be paired to a person — and what that person writes is an instruction. Everyone else is
						heard, quoted, and not obeyed.
					</p>
					<p className="small muted">
						Neither costs a domain, a certificate or an open port: both reach out rather than being
						reached. <Link href="/docs/email/">Email</Link>,{" "}
						<Link href="/docs/telegram/">Telegram</Link> and{" "}
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
						servers go on a shelf the plane keeps, so finding one happens once and every agent after
						the first is a name off a list. Anything with a server is an errand you can hand over:
						the tracker, the error reporter, the database, the browser.
					</p>
					<p>
						A server that wants an account is logged into from the console, because that is where
						the browser is. The consent screen opens on your machine, and the token that comes back
						stays on the plane. What the agent gets is the tool; what it never gets is the secret —
						the same rule as the model key and every other credential here.
					</p>
					<p className="small muted">
						Nothing was woken to answer that command and nothing was spent — a line starting with{" "}
						<code>/</code> is about the agent rather than said to it.{" "}
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
						<code>squad</code> on its own opens the console, because someone typing the command with
						nothing after it is asking to see the thing, not to be told a fact about it. It is the
						one at the top of this page: every agent on the left, the conversation on the right,{" "}
						<code>tab</code> for the log feed, <code>/</code> for the commands and <code>!</code>{" "}
						for the shell inside the box.
					</p>
					<p>
						Everything a plane knows is configured from in there — a key, a model, a mailbox, an MCP
						server, a ceiling — and holds from the next turn with nothing restarted. There is no
						file you edit and redeploy to change what an agent is allowed to think with.
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
						A request that was refused, or came back 401 or 429, is said the moment it happens,
						because it is the reason the agent is about to misbehave. The hundred that worked are
						counted rather than printed, so the feed is something a person can actually read.
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
						The sandbox network is unrouted, so the proxy is not a convenience it could route
						around: reaching the model provider is an approval like any other, written onto the
						request on its way out. <Link href="/docs/trust/">Trust</Link> and{" "}
						<Link href="/docs/grants/">reach</Link> are where that is spelled out.
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
							<strong>Anything multi-tenant.</strong> One config file, one operator, one machine. It
							is your box and every agent on it is yours.
						</li>
						<li>
							<strong>Isolation stronger than a container.</strong> One Docker container per agent,
							not a microVM — because if self-hosting needed microVMs nobody would run it. It is not
							a boundary to put hostile code inside.
						</li>
						<li>
							<strong>A hosted anything.</strong> There is no account, no dashboard and no bill from
							us. You bring a machine and a model key, and what it costs is what your provider
							charges.
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
