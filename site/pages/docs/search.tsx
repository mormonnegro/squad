import Link from "next/link";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Search() {
	return (
		<Docs
			title="Web search"
			lede="Reaching the web is not what makes an agent able to search. Fetching ten results and reading them is a job, and an agent doing it by hand spends its whole context on the reading before it gets to the thinking."
			description="How web_search works: one hosted provider chosen on the config screen, one granted endpoint, and the reading done on the far side of it."
		>
			<section>
				<span className="eyebrow">Why it is a tool</span>
				<h2>The searching and the reading happen somewhere else</h2>
				<p>
					<code>web_search</code> is a pi extension shipped in the sandbox image, like{" "}
					<code>wake_me</code>. It posts the question to a hosted search that reads the pages itself
					and answers in prose with its sources linked in — so what comes back into the agent's
					context is an answer rather than ten pages of HTML.
				</p>
			</section>

			<section>
				<span className="eyebrow">Setting it up</span>
				<h2>Choosing the provider is the whole of it</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ Choosing here is the whole of setting it up — the host, the    │
│ key and what a search costs come with the provider, and the    │
│ proxy is told to pay for that one endpoint and nothing else.   │
│                                                                │
│ ● provider   openai                                            │
│ ● model      gpt-5-mini                                        │
│ ● key        OPENAI_API_KEY                                    │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ 2 to search with   $0.010 a search here                    │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					Where that provider lives, the one endpoint on it that searches, the variable its key is
					read from and what a search costs are facts about the provider rather than decisions, so
					none of them is asked for. The dot is the same on all three rows because none of them is
					in force without the key — a provider and a model chosen against a key this plane does not
					hold is a search refused at the proxy, and one mark that says so is better than two that
					disagree.
				</p>
				<p>
					What the plane derives from that screen is <code>api.openai.com</code>,{" "}
					<code>POST /v1/responses</code>, bearer from <code>OPENAI_API_KEY</code> — and{" "}
					<Link href="/docs/grants/">the path scope</Link> is the part worth keeping. The same key
					against the rest of that API is a second model to think with, bought by whoever takes the
					agent over, and a grant that only opens the endpoint which searches is one that cannot be
					spent on anything else.
				</p>
				<p className="small muted">
					Every agent gets it, because it is a tool rather than a reach: the question goes to one
					host and the answer comes back, and no agent is narrowed by being kept off it. Writing the
					grant out by hand in <code>deploy/config.yaml</code> still works and still wins, if you
					want the endpoint pinned somewhere a console cannot move it.
				</p>
			</section>

			<section>
				<span className="eyebrow">Two details that show</span>
				<h2>curl, and a failure said out loud</h2>
				<p>
					The tool reaches the proxy with <code>curl</code> rather than <code>fetch</code>, because
					a sandbox has no DNS and no route out except that proxy: Node's <code>fetch</code> reads
					neither <code>HTTPS_PROXY</code> nor <code>NODE_EXTRA_CA_CERTS</code> and dies resolving
					the name. Nothing sends an <code>Authorization</code> — the proxy writes one and strips
					whatever was sent, so an agent holding a key could not spend it and this one has none to
					hold.
				</p>
				<p className="small muted">
					Without the grant the tool is still there and says at the moment of use that it could not
					search, which is a better failure than an agent quietly answering from memory. Each search
					is billed per call, which is why the tool asks for one question rather than keywords to
					try — and what it costs lands on <Link href="/docs/limits/">the agent's day</Link> like
					everything else.
				</p>
			</section>
		</Docs>
	);
}
