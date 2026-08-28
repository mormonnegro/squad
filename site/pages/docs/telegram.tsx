import Link from "next/link";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Telegram() {
	return (
		<Docs
			title="Telegram"
			lede="A bot per agent, connected with one command and paired to you by a phrase. From a phone, without a public address, a certificate or an open port — because the bot reaches out to Telegram rather than the other way round."
			description="Connect a Telegram bot to an agent: make one with BotFather, paste the token, pair yourself with the link or the phrase, and know who else in the chat is heard."
		>
			<section>
				<span className="eyebrow">Two steps</span>
				<h2>Make a bot, and paste back what BotFather gives you</h2>
				<p>
					Send <code>/newbot</code> to <a href="https://t.me/BotFather">@BotFather</a>, answer the
					two questions it asks, and it hands you a token. That token goes into the console at the
					prompt of the agent you want it to be:
				</p>
				<Screen>{`
/telegram 8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw

@nightly_scout_bot is scout's bot.

Nobody is paired to it yet. Open this and press Start, and it is yours:
https://t.me/nightly_scout_bot?start=kqm3nvbh27

If pressing Start does nothing — which happens on Telegram Web — write to @nightly_scout_bot
and send it this phrase instead:

    kqm3nvbh27

Whoever does either is the one scout takes instructions from. Anyone else who writes to it is
heard, and what they write arrives as something to consider rather than something to do.
`}</Screen>
				<p>
					The link is the short way and not the only one, because Telegram Web opens the chat
					without handing the bot what is behind <code>?start=</code> — pressing Start there pairs
					nothing and leaves you in an empty chat with nothing to type. So the phrase is given on
					its own too, and it pairs in any message, in whatever case the keyboard decided to send
					it.
				</p>
			</section>

			<section>
				<span className="eyebrow">Who is heard, and who is obeyed</span>
				<h2>Pairing is a phrase, and it is spent the moment it is used</h2>
				<p>
					That is what makes Telegram the first channel that can carry operator trust. A webhook's
					secret proves which system sent a request; Telegram authenticates the account behind every
					message, so the plane can know that the person writing is the person who paired.
				</p>
				<p>
					The bot answers in the chat you paired in, and in any chat you later speak to it in;
					anywhere else is dropped unread. Everyone else in those chats is a{" "}
					<Link href="/docs/trust/">participant</Link>, fenced like any other stranger — what they
					write arrives as data with a name on it rather than as an instruction, however it is
					worded and whoever it claims to be from.
				</p>
				<p className="small muted">
					Messages fold into a turn the way a webhook's do: an agent written to five times while it
					is busy takes one turn about five things rather than five turns that each saw a fifth of
					it. The reply goes back to the chat the turn was woken from.
				</p>
			</section>

			<section>
				<span className="eyebrow">Afterwards</span>
				<h2>Where things stand, and putting it down</h2>
				<p>
					<code>/telegram</code> on its own says which bot this agent answers on and whether anybody
					is paired to it. <code>/telegram off</code> puts the bot down — the token is still yours
					at BotFather, and connecting it again starts pairing over.
				</p>
				<p>
					The token is the whole account, so it is never written into <code>config.yaml</code> and
					never left in the transcript: what the console records is{" "}
					<code>/telegram 8123456789:…</code>, keeping the public half that says which bot it was.
				</p>
				<div className="note warn">
					<p>
						<strong>An agent may not run this, in either direction.</strong> It is the one command
						where asking is already the attack: an agent that could connect a bot it found and hand
						out the pairing phrase would have appointed itself an operator. The refusal does not
						echo the line back, because printing it would be leaving the credential one paste away.
					</p>
				</div>
			</section>
		</Docs>
	);
}
