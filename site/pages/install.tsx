import Link from "next/link";
import { Code } from "../components/Code";
import { Layout } from "../components/Layout";
import { CLIENT, CONSOLE, IMAGES, INSTALL, REPO } from "../lib/site";

const FLAGS: [string, string][] = [
	[
		"--name=casa",
		"a second deployment on one machine — its own containers, volumes, networks, ports and agents",
	],
	["--domain=agents.example.com", "put it behind that name, with a certificate it renews itself"],
	["--domain=", "give the name back: the proxy is removed and the plane is on loopback again"],
	[
		"--relay=https://relay.example.com",
		"reach it through a rendezvous instead: nothing published, nothing forwarded, no domain",
	],
	["--verbose", "every path, every file it wrote, and the build streamed rather than buffered"],
	["--build", "build the images here instead of pulling them, which is what working on it needs"],
];

const MACHINES: [string, string, string][] = [
	[
		"Hetzner",
		"https://www.hetzner.com/cloud",
		"the most machine for the money — around €4.50 buys two cores and 4 GB, if a European or US region suits you",
	],
	[
		"Vultr",
		"https://www.vultr.com/pricing/",
		"from about $5, and in more places than the other two put together",
	],
	[
		"DigitalOcean",
		"https://www.digitalocean.com/pricing/droplets",
		"a few dollars more, and the most written about — worth it if this is your first server",
	],
];

export default function Install() {
	return (
		<Layout
			title="install"
			description="One command on the machine the agents will live on. It asks nothing, pulls two images, and ends by printing the address of a console."
		>
			<section className="hero">
				<div className="wrap">
					<h1>Install</h1>
					<p className="lede">
						One command, on the machine the agents will live on. It asks nothing and ends by
						printing one address — which is the console, and the key to it.
					</p>
					<div className="hero-meta">
						<span>No questions</span>
						<span>~1 GB of RAM</span>
						<span>No account, no keys to have ready</span>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">On the machine that will run them</span>
					<h2>One command, and it asks nothing</h2>
					<Code label="on your laptop, or on your server" wrap>{`
$ curl -fsSL ${INSTALL} | sh
`}</Code>
					<p>
						Docker if the machine has none, two images <a href={IMAGES}>pulled rather than built</a>
						, a config with one agent and a ceiling of five dollars a day, and a plane running. Half
						a minute on a machine that already has Docker.
					</p>
					<p>
						<strong>It asks for no keys.</strong> A key is not something you need before the thing
						runs — it is what this plane can pay for, it changes, and a plane takes one while it is
						running. Three secrets in the first minute made them look like prerequisites, which is
						the one thing they are not. They are given in the console, on the screen that exists for
						it, and the plane is using the next one from the moment it is typed.
					</p>
					<p className="small muted">
						Running it again is the update: it pulls, swaps the plane in, and leaves{" "}
						<code>config.yaml</code> alone along with every key and edit in <code>.env</code>. Only
						the lines that say what this install <em>is</em> — which images, which domain — are
						brought up to date, because a file that disagrees with the plane that is running is a{" "}
						<code>docker compose up</code> by hand that quietly starts last month's code.
					</p>
					<div className="note">
						<p>
							<strong>Nothing published to pull is not an error.</strong> A registry that is
							unreachable, a tag that does not exist yet, a fork that publishes nothing — the
							installer says so and builds from the sources instead, which are right there. That
							path is slower and it still works, which is the point of keeping it.
						</p>
					</div>
				</div>
			</section>

			<section id="console">
				<div className="wrap">
					<span className="eyebrow">What it prints</span>
					<h2>The plane serves its own console</h2>
					<Code wrap>{`
Getting in
  Open this, or paste it into a console you host yourself:

    http://127.0.0.1:8789/?t=MekEy-WJ4RPyWP3PjCEntVGhlJN56bE0uNffl2Obhls
`}</Code>
					<p>
						Open it and the console is there — agents, conversations, what each one is doing and
						what it has spent. It is served by the plane itself, out of its own container, so there
						is nothing else to install and nothing of ours between you and it.
					</p>
					<p>
						<strong>That address is the key.</strong> The plane writes a token on the way up, in a{" "}
						<code>0600</code> file only root can read, and holding it is being the operator — the
						protocol has no login of its own and does not want one. So it is pasted, not posted. The
						page trades it for a cookie and cleans the URL, because an address is copied and left in
						a history and a cookie is not.
					</p>
					<p>
						Keys go in from there: the environment picker, then <strong>Keys</strong>. Each provider
						says whether this plane holds one and whether it was typed here or exported by the
						machine, and none of them ever shows a value — the plane answers with the name of the
						key it set and never with the key. A plane holding none says so above the conversation,
						since the alternative is a turn that dies at the model for a reason the screen already
						knew.
					</p>
					<p className="small muted">
						There is a copy of the same console at <a href={CONSOLE}>{CONSOLE}</a>. It holds several
						environments at once and moves between them, which is the only thing it does that the
						one your plane serves does not. It is a convenience, not the way in: what it knows lives
						in your browser and nowhere else, including not here.
					</p>
				</div>
			</section>

			<section id="server">
				<div className="wrap">
					<span className="eyebrow">If it is on a server</span>
					<h2>Give it a name, or forward the port</h2>
					<p>
						The console's port is published on the server's loopback and nowhere else. That is
						deliberate: the plane holds the Docker socket, so it is root-equivalent on that machine,
						and publishing it would be root on the internet behind a token travelling in the clear.
						There are two ways to reach it, and the first one is better.
					</p>
					<Code label="with a name of its own" wrap>{`
$ curl -fsSL ${INSTALL} | sh -s -- --domain=agents.example.com
`}</Code>
					<p>
						Point the DNS at the machine first, then run that. A proxy in front of the plane obtains
						a certificate and renews it, and the install ends with a single{" "}
						<code>https://agents.example.com/?t=…</code>. Nothing to forward, nothing to keep open,
						and it works from any browser.
					</p>
					<p className="small muted">
						The proxy is a compose profile, so a machine that was never given a domain does not run
						it and never takes port 80 waiting for a certificate that is not coming. The plane's own
						exposure does not change: what is published is the proxy.
					</p>
					<p>
						<strong>And if it has neither a domain nor a terminal you want to keep open</strong>, a
						plane can dial out instead: <code>--relay=https://relay.example.com</code> has it meet a
						console at a rendezvous, which works from behind a NAT because nothing is published at
						either end. It ends by printing a code rather than an address, since there is no address
						to give.
					</p>
					<p className="small muted">
						What crosses a relay is sealed with a key both ends derive from this plane's token. The
						relay is handed a room number derived one way from that same token — enough to put two
						sockets together and not enough to recover anything — so it carries the traffic and
						cannot read it. It is off unless asked for, and{" "}
						<a href={`${REPO}/tree/main/packages/relay`}>
							the one we run is the one in the repository
						</a>
						, which is the only reason to believe any of that.
					</p>
					<Code label="or forward it over the SSH you already have" wrap>{`
$ ssh -N -L 18789:127.0.0.1:8789 you@your-server
`}</Code>
					<p>
						Run that on your own computer — not on the server, where that port is already the
						plane's. Then open <code>http://127.0.0.1:18789/?t=…</code> with the token the server
						printed: your port, its key. Any free local port does.
					</p>
					<p className="small muted">
						The address says <code>127.0.0.1</code> because after the forward that is what the
						server is. Nothing is opened on the server — check it with <code>ss -ltn</code> there —
						and there is nothing new to log into, because the bytes cross the connection you already
						had.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">The rest of the command</span>
					<h2>Five flags, and no configuration file to write first</h2>
					<table className="table">
						<tbody>
							{FLAGS.map(([flag, what]) => (
								<tr key={flag}>
									<td>
										<code>{flag}</code>
									</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<Code wrap>{`
$ curl -fsSL ${INSTALL} | sh -s -- --name=casa
`}</Code>
					<p className="small muted">
						Flags rather than only environment variables, because of the shape this is run in:{" "}
						<code>SQUAD_NAME=casa curl … | sh</code> puts the variable on <code>curl</code>, and the
						shell that reads the script never sees it. The install goes to the default name and says
						nothing about it, which looks exactly like success until there are two deployments and
						the second one wrote over the first. A flag crosses the pipe. The variables still work
						when there is no pipe.
					</p>
					<p className="small muted">
						A second deployment shares nothing with the first but the Docker daemon — its own
						containers, volumes, networks, state and agents, on ports derived from its name.{" "}
						<code>SQUAD_VERSION</code> pins which published build to run; left alone it is the
						newest release.
					</p>
				</div>
			</section>

			<section id="a-machine">
				<div className="wrap">
					<span className="eyebrow">If you do not have one yet</span>
					<h2>The machine is five dollars a month</h2>
					<p>
						One vCPU, a gigabyte of memory and ten gigabytes of disk is enough for a few agents, and
						that is the bottom of every provider's list. It needs a Linux with SSH on it and nothing
						else — the installer brings Docker. An old laptop under the desk works too.
					</p>
					<table className="table">
						<tbody>
							{MACHINES.map(([who, href, what]) => (
								<tr key={who}>
									<td>
										<a href={href}>{who}</a>
									</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="small muted">
						Prices move; the shape of the bill does not. The machine is a flat monthly number, and
						the only other cost is what the agents think with — metered by whichever model provider
						you give a key to, and capped by <code>limitUsd</code> at five dollars a day per agent.
						There is nothing to pay for squad itself.
					</p>
					<p className="small muted">
						A gigabyte is enough because the install pulls rather than builds. Building on that
						machine means a dependency tree and a bundler running on it, which at the bottom of the
						list is a build killed for memory — and killed in the middle, which is the worst place
						for an install to stop.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">The one file to edit</span>
					<h2>Say what an agent may reach</h2>
					<p>
						<code>/opt/squad/deploy/config.yaml</code> is the whole surface: agents, what each may
						reach, which models there are to think with, when each wakes up, which webhooks exist,
						and — under <code>defaults</code> — what an agent made later at the keyboard starts
						from. The installer writes a working one; this is the shape of it.
					</p>
					<Code label="deploy/config.yaml">{`
models:
  - id: deepseek-v4-flash      # naming the provider says the rest
    provider: deepseek
  - id: sonnet
    provider: anthropic
    model: claude-sonnet-4-6
  - id: gpt-5
    provider: openai

defaults:
  model: deepseek-v4-flash     # /model moves one agent onto another
  limitUsd: 5                  # dollars a day, reset at midnight UTC
  grants:
    - id: web                  # the road: npm, PyPI, git, anywhere
      host: "*"
      injection:
        kind: none             # and no key of yours goes down it
    - id: search
      host: api.openai.com
      pathPrefix: /v1/responses  # the one endpoint that searches
      methods: [POST]
      injection:
        kind: bearer
        token: { ref: OPENAI_API_KEY }
`}</Code>
					<p className="small">
						What may be reached and what may be spent are two questions, and only the first is
						answered "anywhere". A grant on <code>*</code> that carried a credential is refused when
						the file is read: the road is open, the keys are given to somewhere by name. Delete the{" "}
						<code>web</code> grant and the plane is deny-by-default again, host by host.
					</p>
					<p className="small">
						No secret is in it. It names environment variables and the process holds the values, so
						the file describing what an agent can reach is committable and diffable — a grant nobody
						noticed being added is the failure mode.
					</p>
					<p className="small">
						All three models are listed whether or not this plane holds their keys, because listing
						one is the approval and the key is only what makes it answer.{" "}
						<a href="#console">Keys</a> in the console is where one is pasted in, and it holds from
						the next turn with nothing restarted and this file untouched.
					</p>
					<p className="small muted">
						It is read when the plane starts, so an edit takes hold on{" "}
						<code>docker compose restart control-plane</code> from <code>/opt/squad/deploy</code>.
					</p>
					<div className="note warn">
						<p>
							<strong>The ceiling is already there. Leave it.</strong> An agent can book its own
							next turn, so without <code>limitUsd</code> the first anyone knows of a loop is the
							bill. It sits under <code>defaults</code> so it also covers the agents made later at
							the keyboard, which are exactly the ones nobody remembers to put a ceiling on.
						</p>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">From anywhere else</span>
					<h2>Waking an agent with a webhook</h2>
					<p>
						Port <code>8787</code> is the one thing published to the network, and it takes signed
						requests only. The installer generates the secret and puts it in <code>.env</code> as{" "}
						<code>HOOK_SECRET</code>. The signature covers{" "}
						{/* biome-ignore lint/suspicious/noTemplateCurlyInString: the shape of the signed string */}
						<code>{"${timestamp}.${body}"}</code> and is compared in constant time within a
						freshness window; an unknown hook id answers exactly like a bad signature, and only
						after the body has been read, so the endpoint does not enumerate.
					</p>
					<Code wrap>{`
BODY='{"text":"the nightly build failed"}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HOOK_SECRET" -r | cut -d' ' -f1)"

curl -X POST https://your-vps:8787/hooks/ping \\
  -H "x-squad-timestamp: $TS" \\
  -H "x-squad-signature: $SIG" \\
  -d "$BODY"
`}</Code>
					<p className="small muted">
						A webhook may not carry operator trust, however well signed. The secret proves which
						system sent the request, never that a human meant what is inside it — so the body
						arrives fenced, as data. Events queue per agent and are folded into one turn, and a turn
						that fails leaves its events queued rather than acknowledging them, so a bad API key
						costs a retry instead of the message.
					</p>
					<p className="small muted">
						The other two ways in need nothing published at all, because they reach out instead of
						being reached: <code>/telegram &lt;token&gt;</code> connects a bot to the agent you are
						looking at, and <code>/email &lt;address&gt;</code> connects one mailbox to every agent
						on the plane. Both are paired to a person by a phrase, and both may instruct once they
						are.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">If you would rather stay in the terminal</span>
					<h2>The console has always been a command too</h2>
					<p>
						Same plane, same protocol, different screen. The installer leaves <code>squad</code> on
						the PATH of the machine it ran on, and this puts the same console on the computer you
						sit at — where it asks which plane to drive and keeps the answer.
					</p>
					<Code label="on your laptop" wrap>{`
$ curl -fsSL ${CLIENT} | sh
$ squad
`}</Code>
					<p className="small muted">
						It needs Node 22.18 or newer and nothing else — no Docker, wherever the plane is. A
						plane on a server is reached down <code>ssh vps squad relay</code>, which is the same
						protocol over the connection you already have, so nothing is opened there for this
						either.
					</p>
					<p className="small muted">
						<code>/serve 3000</code> is that connection read backwards: the sandbox network is
						unrouted, so the console opens the port on <em>your</em> loopback instead and prints{" "}
						<code>http://scout.localhost:3000</code> — a link that works on the machine it was
						printed on and nowhere else, and closes when the console does.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Before the VPS</span>
					<h2>Or try the whole thing on your laptop</h2>
					<p>
						The demo builds the images, starts a control plane on a throwaway network, shows what
						the agent can and cannot reach, wakes it with a signed webhook and prints the turn. It
						asks for a model key when it gets to the part that needs one.
					</p>
					<Code>{`
$ git clone ${REPO}
$ cd squad
$ ./deploy/demo.sh up
`}</Code>
					<p className="small muted">
						<code>./deploy/demo.sh down</code> removes the containers, the networks, the volume and
						the state. The only difference from a real deployment is where the state lives: under
						the working tree, because <code>/var/lib</code> needs root and is not shared with Docker
						Desktop on macOS.
					</p>
				</div>
			</section>

			<section id="by-hand">
				<div className="wrap">
					<span className="eyebrow">If you would rather not pipe a script into a shell</span>
					<h2>The same install, by hand</h2>
					<p>
						The repository, the two files the installer would have written, and one <code>up</code>.
						Everything above still applies — this is only the part that fetches and starts.
					</p>
					<Code>{`
$ git clone ${REPO} /opt/squad && cd /opt/squad/deploy
$ cp .env.example .env                # ports, the webhook secret, the origins
$ cp config.example.yaml config.yaml  # what each agent may reach
$ docker compose up -d
`}</Code>
					<p className="small muted">
						<code>SQUAD_IMAGE</code> and <code>SQUAD_SANDBOX_IMAGE</code> in <code>.env</code> name
						which images to run; left alone they are the locally built ones, and{" "}
						<code>docker compose build</code> makes those. Point them at{" "}
						<a href={IMAGES}>the published ones</a> to skip the build.
					</p>
					<p className="small muted">
						<code>config.example.yaml</code> is the reference, with every option commented, and its
						example agent reaches hosts that are not yours — read it through before starting rather
						than after. Without the installer there is no <code>squad</code> on the PATH either, so
						the console is <code>docker compose exec control-plane squad</code>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">If you edit the compose file</span>
					<h2>Two things are load-bearing</h2>
					<ul className="list">
						<li>
							<strong>The control plane runs on the agents' network</strong>, not on the host.
							Containers on an internal network cannot reach the host at all, so a proxy on the host
							is one the agents cannot use.
						</li>
						<li>
							<strong>The state directory is bind-mounted at its own path.</strong> The plane hands
							the daemon that path when mounting the CA into a sandbox, and the daemon resolves bind
							sources on the host, so a convenient container path produces mounts the daemon cannot
							find.
						</li>
					</ul>
					<div className="jump-row">
						<Link href="/" className="jump">
							← what it is
						</Link>
						<a href={REPO} className="jump">
							the README, in full
						</a>
					</div>
				</div>
			</section>
		</Layout>
	);
}
