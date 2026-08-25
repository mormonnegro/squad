import Link from "next/link";
import { Code } from "../components/Code";
import { Layout } from "../components/Layout";
import { INSTALL, REPO } from "../lib/site";

const ASKS: [string, string][] = [
	["Docker", "installed from get.docker.com if the machine has none"],
	["a DeepSeek key", "what the agents think with — skippable, and turns fail until you add one"],
	["an OpenAI key", "how an agent searches the web — optional, the tool says so without it"],
	["an Anthropic key", "the other model the config starts with — optional in the same way"],
];

export default function Install() {
	return (
		<Layout
			title="install"
			description="One command on a fresh VPS. Then you drive it by typing agent, over the SSH connection you already have."
		>
			<section className="hero">
				<div className="wrap">
					<h1>Install</h1>
					<p className="lede">
						One machine with a shell on it. The agents live there; you stay where you are and reach
						them the way you already reach the machine.
					</p>
					<div className="hero-meta">
						<span>One command</span>
						<span>~1 GB of RAM</span>
						<span>No database, no account</span>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">On the machine</span>
					<h2>One command, and it asks for the rest</h2>
					<Code label="on your VPS" wrap>{`
$ curl -fsSL ${INSTALL} | sh
`}</Code>
					<p>
						It installs Docker if there is none, puts the repository in <code>/opt/agent-dive</code>
						, writes a config with one agent and a ceiling of five dollars a day, starts the plane,
						and leaves <code>agent</code> on the PATH.
					</p>
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
						The keys are read from the terminal, not from the pipe, and land in a <code>0600</code>{" "}
						file the agents cannot reach. Every one can be skipped and given later on the setup
						screen in <code>agent</code>, so the install is never held up by a key you have to go
						and find. Nothing else is asked. Run the same command again any time and it becomes the
						update: it pulls, rebuilds, swaps the plane in, and leaves <code>config.yaml</code> and{" "}
						<code>.env</code> alone — the second run is the one that would quietly undo a grant
						somebody added.
					</p>
					<div className="note">
						<p>
							<strong>If you would rather read it first.</strong> It is{" "}
							<a href={`${REPO}/blob/main/deploy/install.sh`}>deploy/install.sh</a>, about two
							hundred lines, and piping a script from a stranger into a shell is a reasonable thing
							to refuse. <a href="#by-hand">The same install by hand</a> is at the bottom of this
							page.
						</p>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">From your computer</span>
					<h2>Then you type its name</h2>
					<p>
						The control surface is a unix socket inside the state directory and it never leaves the
						machine. There is no port to open, no token to issue and nothing to log into: SSH
						already decides who may touch that host, and touching that host is what holding the
						socket means.
					</p>
					<Code label="from your laptop" wrap>{`
$ ssh -t root@your-vps agent
`}</Code>
					<p className="small muted">
						<code>-t</code> because the console takes the terminal over. The installer prints this
						line with your own address in it. Worth an alias, since it is the command you will type
						every day:
					</p>
					<Code label="~/.zshrc" wrap>{`
alias dive='ssh -t root@your-vps agent'
`}</Code>
					<p>
						Everything the console does travels that one connection: the agent list, the log feed,
						the conversation, <code>/limit</code>, <code>/model</code>, <code>/mcp</code>, and{" "}
						<code>!</code> into the sandbox itself.
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
						<code>/opt/agent-dive/deploy/config.yaml</code> is the whole surface: agents, what each
						may reach, which models there are to think with, when each wakes up, which webhooks
						exist, and — under <code>defaults</code> — what an agent made later at the keyboard
						starts from. The installer writes a working one; this is the shape of it.
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
    - id: search
      host: api.openai.com
      pathPrefix: /v1/responses  # the one endpoint that searches
      methods: [POST]
      injection:
        kind: bearer
        token: { ref: OPENAI_API_KEY }
`}</Code>
					<p className="small">
						No secret is in it. It names environment variables and the process holds the values, so
						the file describing what an agent can reach is committable and diffable — a grant nobody
						noticed being added is the failure mode.
					</p>
					<p className="small">
						All three are listed whether or not this plane holds their keys, because listing one is
						the approval and the key is only what makes it answer. A model missing its key is
						refused at the proxy until somebody supplies one, and the setup screen in{" "}
						<code>agent</code> — <code>tab</code> past logs — is the list of which ones are waiting,
						and where a key is pasted in. It holds from the next turn, with nothing restarted and
						this file untouched.
					</p>
					<p className="small">
						That screen adds models too, on the row that says <code>+ a model</code>: a name, the
						provider it thinks on, and the provider&rsquo;s own name for it when it differs. So this
						file is where a model goes to survive a redeploy, and the console is where one goes when
						you want it on the next turn. A model added there is kept beside this file rather than
						written into it, and a model this file declares is one the console will read and refuse
						to touch.
					</p>
					<p className="small muted">
						It is read when the plane starts, so an edit takes hold on{" "}
						<code>docker compose restart control-plane</code> from{" "}
						<code>/opt/agent-dive/deploy</code>.
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
  -H "x-agent-dive-timestamp: $TS" \\
  -H "x-agent-dive-signature: $SIG" \\
  -d "$BODY"
`}</Code>
					<p className="small muted">
						A webhook may not carry operator trust, however well signed. The secret proves which
						system sent the request, never that a human meant what is inside it — so the body
						arrives fenced, as data. Events queue per agent and are folded into one turn, and a turn
						that fails leaves its events queued rather than acknowledging them, so a bad API key
						costs a retry instead of the message.
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
$ cd agent-dive
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
$ git clone ${REPO} /opt/agent-dive && cd /opt/agent-dive
$ docker build -t agent-dive/sandbox:dev packages/sandbox/image
$ cd deploy
$ cp .env.example .env                # the keys the proxy injects
$ cp config.example.yaml config.yaml  # what each agent may reach
$ docker compose up -d --build
`}</Code>
					<p className="small muted">
						<code>config.example.yaml</code> is the reference, with every option commented, and its
						example agent reaches hosts that are not yours — read it through before starting rather
						than after. Without the installer there is no <code>agent</code> on the PATH either, so
						the console is <code>docker compose exec control-plane agent</code>.
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
