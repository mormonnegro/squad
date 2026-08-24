import Link from "next/link";
import { Code } from "../components/Code";
import { Layout } from "../components/Layout";
import { REPO } from "../lib/site";

export default function Install() {
	return (
		<Layout
			title="install"
			description="Put agent-dive on a VPS with Docker and Compose, and drive it from your own terminal over SSH."
		>
			<section className="hero">
				<div className="wrap">
					<h1>Install</h1>
					<p className="lede">
						One machine with Docker on it. The agents live there; you stay where you are and reach
						them the way you already reach the machine.
					</p>
					<div className="hero-meta">
						<span>Docker and Compose</span>
						<span>~1 GB of RAM</span>
						<span>No database, no account</span>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Before the VPS</span>
					<h2>Try the whole thing on your laptop</h2>
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
						the state. The only difference from a real deployment is where the state lives.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">On the machine</span>
					<h2>Three commands and a config file</h2>

					<div className="step">
						<span className="step-n">1</span>
						<h3>Build the sandbox image and start the plane</h3>
						<p className="small muted">
							The sandbox image is what an agent runs inside, and it carries the tools the plane
							ships: <code>wake_me</code>, <code>web_search</code> and the MCP client.
						</p>
						<Code>{`
$ git clone ${REPO} && cd agent-dive
$ docker build -t agent-dive/sandbox:dev packages/sandbox/image
$ cd deploy
$ cp .env.example .env                # the keys the proxy injects
$ cp config.example.yaml config.yaml  # what each agent may reach
$ docker compose up -d --build
`}</Code>
					</div>

					<div className="step">
						<span className="step-n">2</span>
						<h3>Say what an agent may reach</h3>
						<p>
							<code>config.yaml</code> is the whole surface: agents, what each may reach, when each
							wakes up, which webhooks exist, and — under <code>defaults</code> — what an agent made
							later at the keyboard starts from.
						</p>
						<Code label="deploy/config.yaml">{`
defaults:
  provider: deepseek
  model: deepseek-v4-flash
  limitUsd: 5                  # dollars a day, reset at midnight UTC
  grants:
    - id: model
      host: api.deepseek.com
      injection:
        kind: bearer
        token: { ref: MODEL_KEY }
    - id: search
      host: api.openai.com
      pathPrefix: /v1/responses  # the one endpoint that searches
      methods: [POST]
      injection:
        kind: bearer
        token: { ref: SEARCH_KEY }
`}</Code>
						<p className="small">
							No secret is in it. It names environment variables and the process holds the values,
							so the file describing what an agent can reach is committable and diffable — a grant
							nobody noticed being added is the failure mode.
						</p>
						<div className="note warn">
							<p>
								<strong>Give it a ceiling.</strong> An agent can book its own next turn, so without{" "}
								<code>limitUsd</code> the first anyone knows of a loop is the bill. Putting it under{" "}
								<code>defaults</code> covers the agents made later at the keyboard, which are
								exactly the ones nobody remembers to put a ceiling on.
							</p>
						</div>
					</div>

					<div className="step">
						<span className="step-n">3</span>
						<h3>Check that it came up</h3>
						<Code>{`
$ docker compose exec control-plane agent ls
$ docker compose logs -f control-plane
`}</Code>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">From your computer</span>
					<h2>You connect over SSH, and that is the whole of it</h2>
					<p>
						The plane's control surface is a unix socket inside the state directory, and it never
						leaves the machine. There is no port to open, no token to issue and nothing to log into:
						SSH already decides who may touch that host, and touching that host is what holding the
						socket means.
					</p>
					<Code label="from your laptop" wrap>{`
$ ssh -t vps 'cd agent-dive/deploy && docker compose exec control-plane agent'
`}</Code>
					<p className="small muted">
						<code>-t</code> because the console takes the terminal over. Worth an alias, since this
						is the command you will type every day:
					</p>
					<Code label="~/.zshrc" wrap>{`
alias dive='ssh -t vps "cd agent-dive/deploy && docker compose exec control-plane agent"'
`}</Code>
					<p>
						Everything the console does travels that one connection: the agent list, the log feed,
						the conversation, <code>/limit</code>, <code>/mcp</code>, and <code>!</code> into the
						sandbox itself.
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
					<span className="eyebrow">From anywhere else</span>
					<h2>Waking an agent with a webhook</h2>
					<p>
						Port <code>8787</code> is the one thing published, and it takes signed requests only.
						The signature covers{" "}
						{/* biome-ignore lint/suspicious/noTemplateCurlyInString: the shape of the signed string */}
						<code>{"${timestamp}.${body}"}</code> and is compared in constant time within a
						freshness window; an unknown hook id answers exactly like a bad signature, and only
						after the body has been read, so the endpoint does not enumerate.
					</p>
					<Code wrap>{`
BODY='{"text":"the nightly build failed"}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$DEPLOY_HOOK_SECRET" -r | cut -d' ' -f1)"

curl -X POST https://your-vps:8787/hooks/deploys \\
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
