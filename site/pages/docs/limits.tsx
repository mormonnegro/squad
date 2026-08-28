import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Limits() {
	return (
		<Docs
			title="Spending"
			lede="An agent that books its own next turn is one that goes on running with nobody watching, and until there is a ceiling the first anyone knows of a loop is the bill."
			description="Dollars a day per agent, where the ceiling is set, what happens at it, and why this is the one setting the keyboard may lower."
		>
			<section>
				<span className="eyebrow">The ceiling</span>
				<h2>Dollars a day, and a day that belongs to the plane</h2>
				<Code label="deploy/config.yaml">{`
defaults:
  limitUsd: 5
`}</Code>
				<p>
					US dollars a day, counted across every turn and reset at midnight UTC — the plane's
					midnight, since one of the two machines has to decide when the day turns over and it is
					the plane that enforces it. In <code>defaults</code> it covers the agents made later at
					the keyboard too, which are exactly the ones nobody remembers to put a ceiling on; an
					agent's own block narrows it, and leaving it out is no ceiling at all.
				</p>
				<p className="small muted">
					What a turn cost was reported on the feed all along and added up nowhere, which is the
					same as not knowing.
				</p>
			</section>

			<section>
				<span className="eyebrow">Reaching it</span>
				<h2>It stops the agent taking turns, not a turn in flight</h2>
				<p>
					The point is not to kill work halfway, which has already been paid for, but not to start
					more. Nothing is lost: messages that arrive while it is over the ceiling are in the
					conversation, written down when they arrived, and the plane says there why it is not
					answering. That matters more than it sounds, because a plane that quietly stops answering
					is indistinguishable from a broken one. The next day it goes on.
				</p>
			</section>

			<section>
				<span className="eyebrow">Moving it</span>
				<h2>/limit, and both halves in the conversation</h2>
				<Screen>{`
> /limit
$0.42 spent today, against no limit.
> /limit 5
Spending limit set to $5.00 a day. $0.42 spent today, of $5.00 a day.
`}</Screen>
				<p>
					<code>/limit</code> moves it for one agent without editing the file. Both halves go into
					the conversation, because that is where they were typed and where the answer gets read: a
					ceiling that changed with nothing to show for it is one nobody can later work out the
					reason for.
				</p>
				<p>
					<code>/limit off</code> means no ceiling and not "forget I said anything" — the config's
					value does not come back, since reinstating the ceiling somebody was in the act of
					removing is a surprise they would find out about by hitting it.
				</p>
			</section>

			<section>
				<span className="eyebrow">Where it shows</span>
				<h2>On the row, before it is a question anyone asks</h2>
				<Screen>{`
│ agents               │
│                      │
│ ● demo         $4.10 │
│ ○ scout              │
│                      │
│ + new agent          │
`}</Screen>
				<p>
					What each agent has spent today is on its row, because "which of these is burning through
					its day" is a question about all of them at once and the header can only ever answer it
					about the one you are standing on. The figure turns yellow at four fifths of the ceiling
					and red at it. An agent that has spent nothing says nothing — a column of{" "}
					<code>$0.00</code> is noise to read past, and what is being looked for here is the row
					that is not like the others.
				</p>
				<p className="small muted">
					The title row says what the selected agent is thinking with and what that has cost against
					what it is allowed. Both were already crossing the socket and being thrown away, and the
					price of that was that the way to find out which model an agent was answering badly with
					was to go and read the operator's config file.
				</p>
			</section>

			<section>
				<span className="eyebrow">Why an agent may ask</span>
				<h2>To be held to less, never to more</h2>
				<Screen>{`
‹ask› /limit 50
This agent asked for a ceiling of $50.00 a day, which is above the $5.00 it has. It can ask to
be held to less, never to more: /limit $50.00, if you meant it.
`}</Screen>
				<p>
					A ceiling is the one setting the keyboard may touch, and it is safe for the reason a grant
					is not: it can only ever take capability away. So an agent may ask to be held to a tighter
					one and gets nowhere asking for a looser one — and the refusal hands the operator the line
					they would have typed, at the moment it is the answer, in the pane they were already
					looking at. <Link href="/docs/console/">The console</Link> has the rest of what an agent
					may ask for.
				</p>
			</section>
		</Docs>
	);
}
