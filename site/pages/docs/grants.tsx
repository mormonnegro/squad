import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Grants() {
	return (
		<Docs
			title="Reach"
			lede="Two questions get asked about every request, and the mistake is answering them together. What an agent may reach and whose credential goes with it have very different blast radii."
			description="The egress proxy, the grants that answer where an agent may go, and the credentials it never holds."
		>
			<section>
				<span className="eyebrow">The road is open</span>
				<h2>Because a registry is never one host</h2>
				<Code label="deploy/config.yaml">{`
defaults:
  grants:
    - id: web
      host: "*"
      injection:
        kind: none
`}</Code>
				<p>
					An agent asked for a hello-world page needs <code>npm install</code> before it needs
					anything else, and a registry is never one host — npm is a registry and a CDN, PyPI is an
					index and a file server, a <code>git clone</code> is three names before it is a checkout.
					A list of them is a list that is wrong by one, and wrong by one is worse than either end:
					it looks like it works until the afternoon it doesn't, and what the agent does then is not
					raise its hand. It reads the deny as the internet being down and writes the page it was
					asked for as a paragraph about not being able to write it.
				</p>
				<p>
					Every request still crosses the proxy, is still matched, and still lands in the audit log
					with the host and the path it went to. Delete the <code>web</code> grant and the plane is
					deny-by-default again, host by host, exactly as it was.
				</p>
			</section>

			<section>
				<span className="eyebrow">The keys are not</span>
				<h2>kind: none is the whole of why that line is safe to write down</h2>
				<p>
					Nothing of yours is attached to anything reached through the open grant. A grant on{" "}
					<code>*</code> that carried a credential would put that secret on every server the agent
					reaches, so it is refused where the config is read rather than discovered later:
				</p>
				<Screen>{`
Invalid configuration:
  - defaults.grants[0] is host "*" with a bearer credential, which would put that secret on
    every server the agent reaches. Name the host, or use injection: { kind: none }
`}</Screen>
				<p>
					A named host always wins the request over the open one, so the model's key goes to the
					model and nowhere else. The token is written onto the request after it has matched, on the
					way out — the agent never holds it, and an agent talked into posting its environment
					somewhere has nothing to post.
				</p>
				<Code label="deploy/config.yaml">{`
agents:
  - id: scout
    grants:
      - id: github-issues
        host: api.github.com
        pathPrefix: /repos/acme/website/issues
        methods: [GET, POST]
        injection:
          kind: bearer
          token: { ref: GITHUB_TOKEN }
`}</Code>
				<p className="small muted">
					<code>ref</code> names a variable of the control plane's own environment, never a value.
					An agent's own block adds to the defaults rather than replacing them, and a grant it
					declares with the same id wins — which is how one agent is narrowed without narrowing the
					rest.
				</p>
			</section>

			<section>
				<span className="eyebrow">Adding a host</span>
				<h2>The refusal arrives in a turn, and the answer should not be a deploy</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ An agent has no route out of its own: the sandbox sits on a    │
│ network with nowhere to go, and every request it makes is one  │
│ the proxy was told beforehand to allow. A host that is not on  │
│ this list is a connection refused.                             │
│                                                                │
│ A host opened here carries nothing. Keys are attached by name, │
│ in deploy/config.yaml, and that is the half of a grant this    │
│ screen has no box for — so what is added here widens where an  │
│ agent may go and not one thing about what it may spend.        │
│                                                                │
│ ● api.anthropic.com                       with a model         │
│ ● api.openai.com     /v1/responses  POST  for searching        │
│ ● api.github.com                          from the file        │
│ ● api.chess.com                           opened here          │
│ + a host                                                       │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ carries nothing   opened here   ⌫ closes it                │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					Host by host is a fine way to run this, and it stops being one the moment a host has to be
					added by editing a file on the server and putting the plane back up. What that costs is
					not the minute: it is that the refusal arrives in an agent's turn, hours after the file
					was last thought about.
				</p>
				<p>
					One box and one word — <code>api.chess.com</code>, or the whole URL you were looking at
					when the refusal happened, since the host is read out of it. What a person has to hand at
					that moment is the address in the error and not the host in it. There is no field for a
					path, a method, an id or a key. The last of those is the point: this screen writes{" "}
					<code>injection: {"{ kind: none }"}</code> and has nowhere to express anything else, so
					the console can widen where an agent goes and can never decide what it spends. That half
					stays in the file, which is why the rows that came from it refuse <code>⌫</code> and say
					which list to change them on instead.
				</p>
				<p className="small muted">
					A grant the plane derived is marked for what derived it — <code>with a model</code>,{" "}
					<code>for searching</code> — because a host you cannot account for is one nobody dares
					close. <Link href="/docs/models/">Models</Link> and{" "}
					<Link href="/docs/search/">web search</Link> are where those two come from.
				</p>
			</section>

			<section>
				<span className="eyebrow">What it does not claim</span>
				<h2>The boundary that carries weight is the one around the secrets</h2>
				<p>
					An agent that can run code in a sandbox and reach the internet can send what it read to
					somewhere you did not choose. That was already true of any grant broad enough to be
					useful, and it is the reason the credential is the thing held away from it rather than the
					address. A stolen agent gets the reach it had; it does not get your account.{" "}
					<Link href="/docs/trust/">Trust</Link> is the rest of that.
				</p>
				<p className="small muted">
					One kind of grant carries a scope the method cannot: a git repository, where a clone and a
					push are both a GET and a POST under the same path.{" "}
					<Link href="/docs/repos/">Repositories</Link> is how the branches are named, and how a
					push to the wrong one is turned down.
				</p>
			</section>
		</Docs>
	);
}
