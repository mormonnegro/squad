import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Schedules() {
	return (
		<Docs
			title="Schedules"
			lede="A standing job you wrote, and a turn the agent books for itself. One of the two may instruct, and it is the one you wrote."
			description="Cron schedules in the config file, and wake_me: how an agent asks for another turn, what it may leave itself, and why that wakeup never carries operator trust."
		>
			<section>
				<span className="eyebrow">The one you wrote</span>
				<h2>Cron, in the agent's own block</h2>
				<Code label="deploy/config.yaml">{`
schedules:
  - kind: cron
    expression: "0 9 * * 1-5"
    timeZone: America/Argentina/Buenos_Aires
    channel: cron:standup
    body: Summarise yesterday's issues and post the standup note.
    # An operator wrote this line, so the wakeup may instruct.
    trust: operator
    createdBy: operator
`}</Code>
				<p>
					Vixie cron semantics, matched against the wall clock in the zone you name, so a job at
					nine in the morning is at nine in the morning on both sides of a daylight-saving change
					rather than at eight for half the year. One-shot wakeups are the other kind, and both are
					persisted — a plane that restarts comes back owing the same appointments.
				</p>
				<p className="small muted">
					<code>trust: operator</code> is allowed here and nowhere else that an agent can reach,
					because a line in this file is something an operator typed. That is what makes a schedule
					able to say <em>do this</em> rather than <em>somebody said this</em>.
				</p>
			</section>

			<section>
				<span className="eyebrow">The one it books</span>
				<h2>wake_me asks for another turn and leaves itself a note</h2>
				<Screen>{`
00:12:36  demo      wake_me     {"afterSeconds":180,"note":"Volver a chequear si example.com sigue
                                arriba. Primera verificación: HTTP 200 a las 00:12."}
00:15:38  demo      bash        curl -sS -o /dev/null -w "HTTP %{http_code}" -m 15 https://example.com
`}</Screen>
				<p>
					Work that does not finish in one sitting used to end with the turn. <code>wake_me</code>{" "}
					is a pi extension shipped in the sandbox image, so it is the plane's to fix rather than
					the agent's to edit. The wait shows beside the agent in the console —{" "}
					<code>● demo 3m</code> — because an agent about to act with nobody watching should not
					need a command to notice.
				</p>
				<p>
					There is no path from the sandbox to the plane, and this does not open one: the request is
					a file the agent writes, which the plane reads and removes once the turn is over. So the
					plane checks it rather than trusting it. One wakeup is pending at a time, so asking again
					moves the appointment instead of adding to it; the delay is held between a second and a
					month; and the wakeup carries <Link href="/docs/trust/">participant trust</Link>, never
					operator, however it asks.
				</p>
				<p className="small muted">
					Calling it off is a second tool, <code>cancel_wake</code>, rather than a time that means
					never — the clamp is exactly why there is no such time, so an agent pushing its wakeup a
					year away to be rid of it has only moved it a month, and left believing otherwise.
				</p>
			</section>

			<section>
				<span className="eyebrow">Where the answer goes</span>
				<h2>A wakeup answers where the conversation is</h2>
				<p>
					Ask by mail for a joke every minute and the second joke arrives by mail like the first:
					the appointment carries the channel the turn that booked it was answering, and so does the
					appointment that turn books after it. A wakeup used to answer to the agent itself, which
					is why the first joke arrived and the rest were written, paid for, and said to nobody.
				</p>
				<p>
					A wakeup that comes due while somebody is writing is folded into the same turn, and there
					the conversation wins the tie: an agent that booked on its own note instead would have
					nothing but its own notes in front of it ever after, and would book the next one the same
					way.
				</p>
				<p className="small muted">
					A turn books its wakeup once. The second ask in the same turn is refused, because it is
					not an agent changing its mind about when — it is an agent that read{" "}
					<em>you will be woken at 09:41</em> as the waiting being over. One asked for a joke a
					minute told two hundred of them in a single turn that way, three seconds apart. Changing
					one's mind is <code>cancel_wake</code> and then asking again, which says out loud that the
					appointment is gone.
				</p>
				<p className="small muted">
					Calling it off drops what the appointment has already produced as well as the appointment
					— a ten-second wakeup fires while a two-minute turn is running and queues behind it. Only
					its own bookings go: a message somebody typed at a busy agent is owed an answer whatever
					the agent decided while it sat in the queue.
				</p>
			</section>
		</Docs>
	);
}
