import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Models() {
	return (
		<Docs
			title="Models"
			lede="A model is the one capability every agent needs and the one nobody thinks of as a capability. Naming a provider is the whole of configuring it."
			description="Declare models in the config file or add them from the console, give the plane a key, and move one agent onto another model with /model."
		>
			<section>
				<span className="eyebrow">Declaring one</span>
				<h2>A list, and mostly just a provider</h2>
				<Code label="deploy/config.yaml">{`
models:
  - id: deepseek-v4-flash      # the id doubles as the model when it already is one
    provider: deepseek

  - id: sonnet
    provider: anthropic
    model: claude-sonnet-4-6

defaults:
  model: deepseek-v4-flash     # where every agent starts
`}</Code>
				<p>
					It used to be four coupled things — the provider, the model, a placeholder key in the
					sandbox's environment and a grant naming the provider's host — and any one of them wrong
					is not a startup error but a turn that dies at the proxy, complaining about something the
					operator never typed. Where a provider lives, what its key is called and whether the key
					goes in a bearer header or one of its own are facts about the provider rather than
					decisions anybody gets to make, so they are not written out.
				</p>
				<p className="small muted">
					A provider nothing here knows still works by saying the two things the table would have
					said: a <code>host</code> and a <code>keyEnv</code>. The key itself is never in this file
					and never in the agent — <code>keyEnv</code> names a variable of the control plane's own
					environment, and the grant each model produces is what writes it onto the request on the
					way out.
				</p>
			</section>

			<section>
				<span className="eyebrow">Moving an agent</span>
				<h2>/model is a choice among what exists</h2>
				<Screen>{`
 ▸ /model flash   deepseek/deepseek-v4-flash   (this one)
   /model sonnet  anthropic/claude-sonnet-4-6
   /model gpt-5   openai/gpt-5   (no OPENAI_API_KEY)
╭──────────────────────────────────────────────────────────────────────╮
│ > /model                                                             │
╰──────────────────────────────────────────────────────────────────────╯
 ↑↓ model   ⏎ choose   ^C quit
`}</Screen>
				<p>
					Each row says the two facts about a model that are not its name — whose it is and what
					they call it — plus the one that decides whether the next turn answers at all. A model
					this plane holds no key for is offered and marked, not hidden, because it is configured
					and the missing half is a key you can paste in two panes over. Typing narrows the list
					against the id, the provider and the provider's own name together, so{" "}
					<code>/model anthropic</code> finds the one called <code>sonnet</code>.
				</p>
				<p>
					Every model on that list is already reachable by every agent — configuring one is what
					granted it — so moving between them changes what a turn costs and how good it is, and
					changes nothing at all about what the agent can get to. That is what makes it a command
					rather than an edit and a restart, and it is why an agent is allowed to ask for it.
				</p>
				<p className="small muted">
					Nothing is recreated to do it. The container was started holding a placeholder for every
					provider this knows, and the runner asks what to think with at the start of every turn —
					so a switch lands on the next turn, and a turn already running finishes on the model it
					was handed when it started. That last part is said out loud, because the change looks
					instant and is not.
				</p>
			</section>

			<section>
				<span className="eyebrow">The keys</span>
				<h2>Both halves are a list on the config screen</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ holds from the next turn — nothing restarts.                   │
│                                                                │
│ providers                                                      │
│ ● deepseek   DEEPSEEK_API_KEY   flash                          │
│ ○ anthropic  ANTHROPIC_API_KEY  sonnet                         │
│ ○ openai     OPENAI_API_KEY     gpt-5                          │
│ ○ groq       GROQ_API_KEY       no models                      │
│                                                                │
│ models                                                         │
│ ● flash   deepseek   from the file                             │
│ ○ sonnet  anthropic  from the file                             │
│ ○ gpt-5   openai     added here                                │
│ + a model                                                      │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ ANTHROPIC_API_KEY   no key, refused at the proxy           │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					A model is three lines of configuration and one exported variable, and the variable is the
					half that is not in the file — so it is the half that gets forgotten. The failure that
					produces is a plane that is running and configured and refused at the proxy, with turns
					dying over a host nobody typed. <code>●</code> is something this plane can use right now
					and <code>○</code> one it cannot, the same mark the agents column uses.
				</p>
				<p>
					<code>⏎</code> on a key takes it, masked as it is typed and never shown again. It goes to
					the plane over the same socket a shell does, and for the same reason: holding that socket
					is what makes somebody the operator, and a key arriving by webhook would be a stranger
					paying with your account. A key pasted here holds on the next turn, with nothing restarted
					and nothing redeployed; an empty line takes it back, and the question goes to the plane's
					own environment again.
				</p>
			</section>

			<section>
				<span className="eyebrow">Adding one at the keyboard</span>
				<h2>+ a model asks the providers rather than asking you</h2>
				<Screen>{`
│ 3 on offer                                                     │
│ › gpt-5-mini   openai                                          │
│   gpt-4o-mini  openai                                          │
│   o4-mini      openai                                          │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ model  openai mini                                         │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					Being handed a key and then asked for a model name is being asked for the one fact the key
					just made the plane able to look up. So every provider it holds a key for is asked what it
					answers to, all at once, and what comes back is a list to arrow through. Typing narrows it
					against the provider and the id together and in any order, so <code>openai mini</code>{" "}
					gets there without remembering which of <code>gpt-5-mini</code> and{" "}
					<code>gpt-5-nano</code> was the one.
				</p>
				<p className="small muted">
					A provider that would not answer is named under the list instead of being counted as
					having nothing, since an empty list is the shape both a wrong key and an empty catalog
					arrive in. Writing one out by hand still works and has to — three words, a name, the
					provider it thinks on and the provider's own name for it, so{" "}
					<code>sonnet anthropic claude-sonnet-4-6</code> is taken as typed.
				</p>
				<div className="note">
					<p>
						<strong>What the file declared is there to be read and not to be changed.</strong>{" "}
						<code>from the file</code> is a row this screen will not shadow and will not drop.
						Everything given here lives in a store beside <code>config.yaml</code> and never in it,
						so a redeploy brings back what was written there and what was typed here survives the
						redeploy on its own. This is the one screen where the keyboard grants rather than pays,
						and that is deliberate: reaching it means holding the plane's control socket, which is
						the whole of being <Link href="/docs/trust/">the operator</Link> here.
					</p>
				</div>
			</section>
		</Docs>
	);
}
