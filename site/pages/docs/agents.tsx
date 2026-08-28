import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

const SELF: [string, string][] = [
	["agent.yaml", "name, model, and the capabilities it asks an operator for"],
	["soul.md", "who it is; appended to the system prompt on every turn"],
	["skills/", "SKILL.md folders, loaded by pi"],
	["memory/", "what it chose to remember, partitioned by users, projects and reference"],
	["tools/", "scripts it wrote for itself"],
];

export default function Agents() {
	return (
		<Docs
			title="Agents"
			lede="A container that stays running, a repository it owns, and a name. Making one is a row on a screen; what it may reach was decided before it existed."
			description="Making an agent, what its repository holds, clearing a conversation, and the difference between an agent you declared and one made at the keyboard."
		>
			<section>
				<span className="eyebrow">Making one</span>
				<h2>The row under the last agent</h2>
				<p>
					It is a row rather than a command because that is where somebody who wants an agent is
					already looking — with none at all it is the only row there is, and the console opens on
					it. The panel behind it takes a name and <code>⏎</code> builds it: a container, a
					repository of its own, nothing in its memory, and exactly what <code>defaults</code> in
					the config allows it to reach.
				</p>
				<p>
					The name is the whole of what the keyboard decides here, which is why the pane says so. It
					may name an agent and it may not grant it a thing. A name that is taken, or that is not a
					name, is refused in the pane with the name still in the prompt to be fixed, and what is
					built appears where the <code>+</code> was, which is where the cursor already is.
				</p>
				<p className="small muted">
					A plane with no <code>defaults</code> makes an agent that cannot reach the model, and says
					so at the moment it is made rather than mid-turn. <code>squad chat maxi</code> at a shell
					is the same offer from the other end: naming an agent that does not exist is what someone
					types when they want one, so it asks.
				</p>
			</section>

			<section>
				<span className="eyebrow">What one is made of</span>
				<h2>A repository it owns</h2>
				<p>
					On its first boot an agent gets a repository in its own volume, at{" "}
					<code>/home/agent/.self</code>:
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
					It is scaffolded once, git-initialised, and then left alone: what the agent learns and
					what it can do are files it edits and commits itself. The control plane never writes there
					again, because the second write would be the control plane overwriting the agent's own
					work.
				</p>
				<p>
					That repository is the agent, not its desk. Turns start next door, in a second volume at{" "}
					<code>/home/agent/workspace</code>, and the house rule goes in as argv on every turn: one
					directory per project, nothing loose at the top, and tidy what you find untidy rather than
					leaving it. It is said by the plane rather than written into <code>soul.md</code> because
					the agent may rewrite its soul, and a rule the subject can edit is not a rule.
				</p>
				<p className="small muted">
					Both volumes outlive the container, which is replaced every time the image changes.
				</p>
				<div className="note">
					<p>
						<strong>Nothing in that repository grants anything.</strong> <code>agent.yaml</code>{" "}
						lists capability <em>requests</em>, and an operator answers them in{" "}
						<Link href="/docs/config/">the config file</Link> the agent cannot reach. An agent that
						can edit its own definition can otherwise grant itself capabilities, which is one of the
						three problems the whole design is shaped around.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">Declared, or made here</span>
				<h2>Two kinds of agent, and one of them is in your file</h2>
				<p>
					An agent can be a block in <code>config.yaml</code>, which is where a description, its own
					grants, its schedules and a tighter ceiling are written. Or it can be a name typed at the
					row above, which the plane writes down in its state directory — since the config file is
					the operator's and no plane may write it.
				</p>
				<Code label="deploy/config.yaml">{`
agents:
  - id: scout
    description: Watches the issue tracker and answers questions about it.
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
					<code>description</code> is used the first time the agent boots, to write its{" "}
					<code>soul.md</code>. After that the repository is the agent's and this file stops having
					an opinion about who it is. An agent's own grants add to the defaults rather than
					replacing them, and one it declares with the same id wins — which is how a single agent is
					narrowed without narrowing the rest.
				</p>
			</section>

			<section>
				<span className="eyebrow">Starting over</span>
				<h2>/clear throws the conversation away and leaves the agent standing</h2>
				<Screen>{`
> /clear
scout has forgotten the conversation.

The repository is untouched: scout's soul, its skills and whatever it wrote down to remember
are what outlive a conversation, and are why throwing one away costs little. So is everything
/model, /mcp, /limit and /serve have set. The next thing said starts it again on nothing.
`}</Screen>
				<p>
					It says that every time, and the saying is half the command: a clear nobody is sure of the
					cost of is one that gets put off until the context is a mess. An agent that has talked
					itself into a corner is rarely one worth deleting, and before this the only way out of the
					corner took the repository with it.
				</p>
				<p className="small muted">
					A conversation lives in three places and all three go together — what the model is shown
					at the start of the next turn, the transcript on disk that outlives the console, and the
					pane you are reading. The turn in flight is stopped first, and that is not a courtesy: the
					session is written out at the end of a turn, so a conversation deleted underneath a
					running one would come straight back with everything in it a minute later.
				</p>
			</section>

			<section>
				<span className="eyebrow">Taking one away</span>
				<h2>There is one kind of delete and it is the whole one</h2>
				<Screen>{`
> /delete
Deleting scout stops its container and throws it away, along with the repository inside
it: everything it wrote, remembered and made for itself. There is no copy of that anywhere
and nothing here can put it back.

Nothing has been deleted yet.
╭──────────────────────────────────────────────────────────────────────╮
│ delete scout?  y / n                                                 │
╰──────────────────────────────────────────────────────────────────────╯
 y delete   n cancel   ^C quit
`}</Screen>
				<p>
					The container, the repository inside it, and the conversation — because a delete that left
					the name sitting in the column is one you were told worked and have to do again. So it
					asks first, in the prompt itself, and the question has the whole keyboard until it is
					answered: <code>y</code> deletes and every other key walks away, including the return that
					was pressed a moment ago to ask it.
				</p>
				<p>
					The asking lives in the console rather than in the plane, and that is the point of it: a
					plane that took <code>/delete scout</code> from anywhere would let one line be the whole
					of an agent. Whatever is typed after the command is dropped and the bare form goes down
					first, so a command reaches no further than the conversation it was typed in.
				</p>
				<p className="small muted">
					An agent you declared in the config goes the same way, which takes one more step than it
					sounds: your file is yours and no plane may write it, so there is nowhere to take the name
					out of. The deletion is written down instead, in <code>deleted.json</code> beside the
					state, and every start from then on skips the name. The answer says so, because the line
					is still in your file and taking it out is the only thing left to do about that agent.
				</p>
				<p className="small muted">
					At a shell, <code>squad rm scout</code> takes the container and leaves the volume, because
					the volume is the agent. <code>--purge</code> deletes that too, and asks for the agent's
					name to be typed first so a reflexive <code>y</code> cannot do it.
				</p>
			</section>
		</Docs>
	);
}
