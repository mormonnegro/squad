import Link from "next/link";
import { Code } from "../components/Code";
import { Layout } from "../components/Layout";
import { CLIENT, INSTALL, REPO } from "../lib/site";

const ASKS: [string, string][] = [
	["Docker", "installed from get.docker.com if the machine has none"],
	["a DeepSeek key", "what the agents think with — skippable, and turns fail until you add one"],
	["an OpenAI key", "how an agent searches the web — optional, the tool says so without it"],
	["an Anthropic key", "the other model the config starts with — optional in the same way"],
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
			description="Install the console on the computer you are sitting at. It asks where the agents should live — here, or on a server you have SSH to — and puts a plane there."
		>
			<section className="hero">
				<div className="wrap">
					<h1>Install</h1>
					<p className="lede">
						Two halves: the console you type at, and the plane the agents live in. You install the
						console, and it asks the one question the halves differ on.
					</p>
					<div className="hero-meta">
						<span>One question</span>
						<span>~1 GB of RAM</span>
						<span>No database, no account</span>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">From your computer</span>
					<h2>One command, and it asks one thing</h2>
					<Code label="on your laptop" wrap>{`
$ curl -fsSL ${CLIENT} | sh
$ squad
`}</Code>
					<p className="small muted">
						It needs Node 22.18 or newer and nothing else — no Docker here, whichever answer you
						give. <a href={`${REPO}/blob/main/deploy/client.sh`}>deploy/client.sh</a> fetches the
						tree, installs what the console imports, and leaves <code>squad</code> on your PATH.
						There is no build step, so what lands is what runs, and running it again is how the
						console updates.
					</p>
					<p>
						The thing it asks is where your agents should live: <strong>on this computer</strong>,
						which means Docker and a state directory under <code>~/.squad</code>, or{" "}
						<strong>on a server</strong> you have SSH to, which means the install running down the
						connection you already have. Either way the same thing lands there — Docker if there is
						none, the repository, a config with one agent and a ceiling of five dollars a day, and
						the plane started — and either way it ends on the console. The answer is remembered, and{" "}
						<code>squad connect</code> moves it.
					</p>
					<p>
						Everything after that question is the same program. A plane answers the same protocol
						whether its socket is in a directory here or at the far end of{" "}
						<code>ssh vps squad relay</code>, so the agent list, the log feed, the console and a
						port forwarded out of a sandbox all run on this computer and reach the agents wherever
						they are. That is also why a port you expose from an agent opens on the machine your
						browser is on, which is the one place it is of any use.
					</p>
					<p className="small muted">
						It asks for no keys. Every one of them is given later on the config screen in{" "}
						<code>squad</code>, because three secrets in the first minute is a worse first minute
						than an empty setup screen in the second. Run the install again any time and it becomes
						the update: it pulls, rebuilds, swaps the plane in, and leaves <code>config.yaml</code>{" "}
						and <code>.env</code> alone — the second run is the one that would quietly undo a grant
						somebody added.
					</p>
					<div className="note">
						<p>
							<strong>Nothing of the console stays on the server.</strong> It pipes one shell script
							— <a href={`${REPO}/blob/main/deploy/install.sh`}>deploy/install.sh</a> — down the SSH
							connection, and that script stands alone: it is below, and it is the same one that
							runs when you pick this computer. <a href="#by-hand">The same install by hand</a> is
							at the bottom of this page.
						</p>
					</div>
				</div>
			</section>

			<section id="a-machine">
				<div className="wrap">
					<span className="eyebrow">If you do not have one yet</span>
					<h2>The machine is five dollars a month</h2>
					<p>
						One vCPU, a gigabyte of memory and ten gigabytes of disk is enough for a few agents, and
						that is the bottom of every provider's list. It needs a Linux with SSH on it and nothing
						else — the installer brings Docker. Any of these work, and so does an old laptop under
						the desk or a machine at work you can reach.
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
						Prices move, so treat those as the shape rather than the quote. What does not move is
						the shape of the bill: the machine is a flat monthly number, and the only other cost is
						what the agents think with, which is metered by whichever model provider you give a key
						to and capped by <code>limitUsd</code> at five dollars a day per agent until you say
						otherwise. There is nothing to pay for squad itself.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Or the far half, yourself</span>
					<h2>What it runs on the machine the agents get</h2>
					<p>
						Run at a terminal instead of down a pipe, the installer asks for the keys as it goes.
						That is the whole difference — same script, and the questions exist only because there
						is now somebody there to answer them.
					</p>
					<Code label="on your VPS" wrap>{`
$ curl -fsSL ${INSTALL} | sh
`}</Code>
					<table className="table">
						<tbody>
							{ASKS.map(([what, why]) => (
								<tr key={what}>
									<td>{what}</td>
									<td>{why}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="small muted">
						They are read from the terminal, not from the pipe, and land in a <code>0600</code> file
						the agents cannot reach. Every one can be skipped and given later on the setup screen.
						Nothing else is asked.
					</p>
					<p className="small muted">
						It leaves <code>squad</code> on that machine's PATH too — the same commands typed there,
						and the door the console here comes through. Three environment variables are what the
						console overrides when the plane is going to live beside it instead:{" "}
						<code>SQUAD_DIR</code>, <code>SQUAD_STATE</code> and <code>SQUAD_SHIM</code>. That is
						the whole of the difference between a laptop and a VPS.
					</p>
					<p className="small muted">
						Whichever end you ran it at, the console is the command above and this machine is an
						answer it keeps — in <code>~/.squad/plane.json</code>, written once and never asked
						again. <code>squad connect</code> asks again, and the installer prints your own address
						when it finishes so there is nothing to go and look up.
					</p>
					<p className="small muted">
						Running that installer again is the update, and <code>squad update</code> runs it on
						whichever machine the plane is on. It pulls the latest, rebuilds both images and swaps
						the plane in; <code>config.yaml</code> and <code>.env</code> are left exactly as they
						are, so nothing you granted or gave it goes away.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Once you are on it</span>
					<h2>Then you type its name</h2>
					<p>
						The control surface is a unix socket inside the state directory and it never leaves the
						machine. There is no port to open, no token to issue and nothing to log into: when the
						plane is on a server, SSH already decides who may touch that host, and touching that
						host is what holding the socket means. <code>squad relay</code> is the console's way in
						— the same socket on a pair of pipes, run over the connection you already have.
					</p>
					<p>
						Everything the console does travels that one connection: the agent list, the log feed,
						the conversation, <code>/limit</code>, <code>/model</code>, <code>/mcp</code>,{" "}
						<code>/serve</code>, and <code>!</code> into the sandbox itself.
					</p>
					<p className="small muted">
						<code>/serve 3000</code> is that connection read backwards. An agent that builds a page
						has nowhere to put it — the sandbox network is unrouted and nothing is published off the
						server — so the console opens the port on <em>your</em> loopback instead, and prints{" "}
						<code>http://scout.localhost:3000</code>. The link works on the laptop it was printed on
						and nowhere else, and it closes when you close the console.
					</p>
					<p className="small muted">
						You do not have to know those commands exist. An agent that needs a tool server can ask
						for one itself, and the consent screen opens in your browser here — the agent gets no
						further than putting the question in front of you. Anything that would widen its reach
						is still yours to type, and asking for one prints you the line.
					</p>
					<div className="note">
						<p>
							<strong>Why there is no web UI to log into.</strong> The control plane holds the
							Docker socket, so it is root-equivalent on the machine — the trust boundary is the
							sandbox around the agent, not the process managing it. Publishing that control surface
							would put root on the internet behind a password somebody chose. SSH is the same
							authentication that already guards the machine, and it is stronger.
						</p>
					</div>
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
						All three are listed whether or not this plane holds their keys, because listing one is
						the approval and the key is only what makes it answer. A model missing its key is
						refused at the proxy until somebody supplies one, and the setup screen in{" "}
						<code>squad</code> — <code>tab</code> past logs — is the list of which ones are waiting,
						and where a key is pasted in. It holds from the next turn, with nothing restarted and
						this file untouched.
					</p>
					<p className="small">
						That screen adds models too, on the row that says <code>+ a model</code> — and it asks
						the providers rather than asking you. Being handed a key and then asked for a model name
						is being asked for the one fact the key just made the plane able to look up, so every
						provider it holds a key for is asked what it answers to, and what comes back is a list
						to arrow through. Typing narrows it against the provider and the id together, so{" "}
						<code>openai mini</code> gets there without remembering the exact id. Writing one out in
						full still works, for a provider with no catalog to ask.
					</p>
					<p className="small">
						So this file is where a model goes to survive a redeploy, and the console is where one
						goes when you want it on the next turn. A model added there is kept beside this file
						rather than written into it, and a model this file declares is one the console will read
						and refuse to touch.
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
						Port <code>8787</code> is the one thing published, and it takes signed requests only.
						The installer generates the secret and puts it in <code>.env</code> as{" "}
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
						Four commands and the two files the installer would have written for you. Everything
						above still applies — this is only the part that fetches and starts.
					</p>
					<Code>{`
$ git clone ${REPO} /opt/squad && cd /opt/squad
$ docker build -t squad/sandbox:dev packages/sandbox/image
$ cd deploy
$ cp .env.example .env                # the keys the proxy injects
$ cp config.example.yaml config.yaml  # what each agent may reach
$ docker compose up -d --build
`}</Code>
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
