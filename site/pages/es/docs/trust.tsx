import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

const LEVELS: [string, string, string][] = [
	[
		"operator",
		"may instruct",
		"an operator wrote it: the control socket, or a schedule an operator set",
	],
	[
		"participant",
		"data, attributed",
		"a known human in a channel — someone else in the Telegram chat",
	],
	["public", "data", "a webhook payload; anyone on the internet"],
];

const WHERE: [string, string][] = [
	[
		"a webhook",
		"May not carry operator trust, however well signed. The secret proves which system sent the request, never that a human meant what is inside it.",
	],
	[
		"Telegram",
		"May, and only from the one account that pressed the pairing link. Everyone else in the chat is a participant, however the message is worded and whoever it claims to be from.",
	],
	[
		"mail",
		"May, and only from an address that paired, and only when the receiving provider's own Authentication-Results says DKIM and DMARC passed aligned with the domain it claims.",
	],
	[
		"a wakeup",
		"An agent may schedule itself, but not with operator trust. Otherwise one successful injection is permanent.",
	],
	[
		"the socket",
		"The one door that carries operator trust. It is 0600, and reaching it already means holding a file the operator owns.",
	],
];

export default function Trust() {
	return (
		<Docs
			title="Trust"
			lede="An agent that runs unattended will eventually read something a stranger wrote. So every event carries a trust level, and only an operator's is rendered as an instruction."
			description="The three trust levels, where each channel may sit, and why the rule is enforced in more than one place."
		>
			<section>
				<span className="eyebrow">Three levels</span>
				<h2>Only one of them may tell an agent what to do</h2>
				<table className="table">
					<tbody>
						{LEVELS.map(([level, may, who]) => (
							<tr key={level}>
								<td>{level}</td>
								<td>
									{may} — {who}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				<p>
					Everything that is not from the operator arrives fenced and introduced as data, in one
					place, so a new channel adapter cannot forget to do it. The fence nonce is random and
					chosen after the content is written, so nothing inside can close it.
				</p>
			</section>

			<section>
				<span className="eyebrow">Enforced more than once</span>
				<h2>Because there is more than one way to launder authority</h2>
				<table className="table">
					<tbody>
						{WHERE.map(([what, rule]) => (
							<tr key={what}>
								<td>{what}</td>
								<td>{rule}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					The wakeup rule is the least obvious and the most load-bearing. If an agent could schedule
					itself with operator trust, one successful injection would be permanent: the injected turn
					schedules a wakeup that instructs, and the agent goes on instructing itself with no
					attacker present to notice or revoke. <Link href="/es/docs/schedules/">Schedules</Link> is
					the rest of that.
				</p>
			</section>

			<section>
				<span className="eyebrow">And it is visible</span>
				<h2>Everything not typed at the console wears a mark</h2>
				<Screen>{`
> how is the queue looking?
four issues open, none of them blocked.
‹wake› check the queue again
still the same.
‹email› and the build?
‹→ email› green since last night.
‹webhook:github› the nightly build failed on main
`}</Screen>
				<p>
					The pane gets read back to work out who asked for what, and a line from a stranger drawn
					the same way as the operator's is the one bug in a chat window that matters. Only what
					arrives on the control socket is drawn as the operator; everything else is named for the
					channel it came in on, your own mail included.
				</p>
			</section>

			<section>
				<span className="eyebrow">What it does not claim</span>
				<h2>The boundary is the sandbox, and the secrets</h2>
				<p>
					The control plane holds the Docker socket, so it is root-equivalent on the machine: the
					trust boundary is the sandbox around the agent, not the process managing it. And an agent
					that can run code in a sandbox and reach the internet can send what it read to somewhere
					you did not choose — that is true of{" "}
					<Link href="/es/docs/grants/">any grant broad enough to be useful</Link>, and it is why
					the boundary that carries weight is the one around the credentials rather than the one
					around the addresses.
				</p>
				<p className="small muted">
					One container per agent, not a microVM — because if self-hosting needed microVMs nobody
					would run it. It is not a boundary to put hostile code inside.
				</p>
			</section>
		</Docs>
	);
}
