import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

const MCP: [string, string][] = [
	["/mcp", "what this agent has, and what is on the shelf"],
	["/mcp add <name> <url>", "find one once: it goes on the shelf, and this agent gets it"],
	["/mcp add <name> sse <url>", "the same, for a server speaking the older transport"],
	["/mcp add <name> <command …>", "a server the agent starts for itself, inside the sandbox"],
	["/mcp <name>", "give this agent one that is already on the shelf"],
	["/mcp login <name>", "the consent screen, opened in your browser"],
	["/mcp drop <name>", "take it off this agent, and leave it on the shelf"],
	["/mcp forget <name>", "take it off the shelf, and off every agent that had it"],
	["/mcp logout <name>", "give the account back, for everyone"],
];

export default function Mcp() {
	return (
		<Docs
			title="MCP servers"
			lede="Tools that live somewhere else, registered as pi's own so the model cannot tell which of them do. Finding a server is the expensive part, and it only has to happen once."
			description="Add MCP servers to the shelf the plane keeps, give them to agents, log into the ones that want an account, and understand why no server holds a credential."
		>
			<section>
				<span className="eyebrow">Where the client is</span>
				<h2>An extension, in the sandbox image</h2>
				<p>
					pi has no MCP client and says so on purpose: build an extension, its README answers. So{" "}
					<code>mcp.ts</code> sits in the sandbox image beside <code>wake_me</code> and{" "}
					<code>web_search</code> and is a whole one — the handshake, all three transports, and the
					tools that come back registered as pi's own.
				</p>
			</section>

			<section>
				<span className="eyebrow">The shelf</span>
				<h2>Found once, given out by name</h2>
				<Screen>{`
> /mcp add linear https://mcp.linear.app/mcp
"linear" is on the shelf, and this agent has it.

Any other agent can have it too, with /mcp linear.

> /mcp
This agent has:
  files   mcp-files /home/agent

On the shelf:
  linear  https://mcp.linear.app/mcp   (logged in)
  sentry  https://mcp.sentry.dev/mcp   (no grant)

/mcp linear gives this agent that one.
`}</Screen>
				<p>
					A URL is a remote server, <code>sse &lt;url&gt;</code> is one speaking the older transport
					— the one thing about a server a line cannot show by itself — and anything else is a
					command the agent starts for itself. From the second agent on it is a name off a list,
					which is the whole point of the shelf being the plane's rather than the agent's.
				</p>
				<table className="table table-cmd">
					<tbody>
						{MCP.map(([cmd, what]) => (
							<tr key={cmd}>
								<td>{cmd}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					The list is written into the sandbox before every turn rather than baked into the
					container, so a server added from the console reaches an agent that is already up on its
					next turn, and one taken away stops being offered.
				</p>
			</section>

			<section>
				<span className="eyebrow">The whole shelf at once</span>
				<h2>And who is holding what</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ A server is something somebody went and found — a URL, a       │
│ command, the reading of a README — so the plane keeps it once  │
│ and every agent after the first is a name off this list.       │
│                                                                │
│ None of them holds a key. A remote one is reached through the  │
│ proxy like every other host, and one that wants an account is  │
│ logged into from an agent that has it, with /mcp login.        │
│                                                                │
│ ● linear  https://mcp.linear.app/mcp                           │
│ ○ notion  https://mcp.notion.com/mcp                           │
│ ● files   mcp-files /home/agent                                │
│   + a server                                                   │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ scout   (logged in)                                        │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					The dot means what it means in the agents column: something that is actually reaching
					anything. A server nobody was given is a URL written down — <code>notion</code> above —
					and finding that is the question you would otherwise open every agent in turn to ask.{" "}
					<code>⏎</code> gives the row under the cursor to the agent <code>tab</code> names, and{" "}
					<code>⏎</code> again takes it back.
				</p>
			</section>

			<section>
				<span className="eyebrow">Accounts</span>
				<h2>There is nowhere in a server to put a credential</h2>
				<p>
					A local one inherits a sandbox whose only road out is{" "}
					<Link href="/es/docs/grants/">the egress proxy</Link>, a remote one is reached down that
					same road, and the proxy already writes whatever key either of them needs. So connecting
					to a server that wants an account is still two things: the line, and a way in. Which way
					is not a question the operator should have to answer out of a README, so the server is
					asked — <code>initialize</code> is what any client sends first, and a server that would
					refuse the agent refuses that identically.
				</p>
				<Screen>{`
> /mcp add notion https://mcp.notion.com/mcp
"notion" is on the shelf, and this agent has it.

It wants an account first: /mcp login notion
`}</Screen>
				<p>
					<code>/mcp login</code> registers a client, opens the consent screen at the console —
					which is the machine the person is at, where a plane in a container is not — and waits on
					port 8788 for the browser to come back. One number rather than one per login, because that
					door has to be published out of the container in advance; the deployment binds it to
					loopback, and one login happens at a time. Where even that cannot be reached, the address
					the browser lands on can be pasted back instead:{" "}
					<code>/mcp login notion &lt;address&gt;</code>.
				</p>
				<p>
					What comes back is held on the plane, <code>0600</code>, next to the CA key. The sandbox
					never sees a token, and neither does the agent. The grant it makes is one host, that
					server's own path, and only for as long as the agent is holding the server —{" "}
					<code>/mcp drop</code> takes the reach with it, and <code>/mcp logout</code> takes it from
					everyone.
				</p>
				<div className="note">
					<p>
						<strong>
							A finished login is the one capability that does not come out of the config file.
						</strong>{" "}
						That is deliberate and it is narrow: a consent screen is a person reading a host name
						and deciding, which is a stronger act of approval than a line of YAML rather than a
						weaker one. An agent can ask for that screen to be put in front of its operator and gets
						no further by asking — what comes back is a person's answer to a question they were
						shown.
					</p>
				</div>
				<p className="small muted">
					A server that wants no account and is still out of reach is the other case, and it stays
					the operator's: <code>/mcp</code> prints the grant to paste but will not write it, because
					putting the whole of an agent's reach one typo away from the box its messages are typed
					into is not a convenience.
				</p>
			</section>

			<section>
				<span className="eyebrow">And the agent is told</span>
				<h2>Which servers it is holding, every turn</h2>
				<Screen>{`
## The MCP servers you have

Read at the start of this turn. The operator adds and removes these between turns, so this is
the list that is true now — not whatever was said about them earlier in the conversation.

- \`ahrefs\` — connected. 134 tools, named \`ahrefs_*\`.
- \`notion\` — did not answer: HTTP 401: unauthorized
`}</Screen>
				<p>
					Having the tools is not the same as knowing they arrived. The console's answer to{" "}
					<code>/mcp login</code> goes to the operator, because the operator is the one with the
					browser it ends in — so an agent that asked for a server is never told it got one. It has
					only its tool list to infer from, and what it does instead is remember: the turn before it
					told the operator the login was pending, so this turn it says so again, sitting on a
					hundred working tools it will not touch. The paragraph goes in every turn rather than
					once, because the turn the list moves on is exactly the one whose history says otherwise.
				</p>
				<p className="small muted">
					A server that will not answer costs the agent that server's tools and not the turn, and it
					is named both ways: to the agent, so it can report what the server said instead of
					guessing what the operator still has to do, and to the operator in the log — the one thing
					they have to go and fix should not be the one thing nobody is told.
				</p>
			</section>
		</Docs>
	);
}
