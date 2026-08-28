import Link from "next/link";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Email() {
	return (
		<Docs
			title="Email"
			lede="One mailbox for the whole plane, connected once. Every agent you have — and every agent you make after this — is reached at the same address with its own name tagged on."
			description="Connect a mailbox to the plane: type the address, make an app password, pair yourself by a phrase, and choose who carries the answers out."
		>
			<section>
				<span className="eyebrow">Why a mailbox you already read</span>
				<h2>Nothing to buy, no domain, no DNS, no open port</h2>
				<p>
					The plane logs in and reads it the way a mail client does. Telegram is a bot per agent;
					email is the whole plane at once, which is why it is connected once and covers the agents
					that do not exist yet.
				</p>
				<p>Type the address. Only the address:</p>
				<Screen>{`
/email agents@fastmail.com

imap.fastmail.com:993 reads agents@fastmail.com and smtp.fastmail.com:465 sends from it.
One app password does both.

Now make an app password. Your ordinary password will not work, and is not the kind of
thing to paste into a console:

    https://app.fastmail.com/settings/security/apppasswords

Then paste it back:

    /email <the app password>
`}</Screen>
				<p>
					The link is the point. Every provider buries that screen somewhere different and none of
					them call it the same thing, so "make an app password" is an instruction that ends in a
					search box — which is the longest part of connecting a mailbox and the part people give up
					in.
				</p>
				<p className="small muted">
					Where the mailbox lives is worked out from the address through autoconfig,{" "}
					<code>.well-known</code>, the ISPDB and SRV before falling back to the conventional guess,
					and when it is a guess the answer says so rather than stating it. Both servers are named
					in one line because the question a password step raises is how many credentials this is
					going to take: it is one, since a provider issues an app password for the account rather
					than for a protocol.
				</p>
				<div className="note warn">
					<p>
						<strong>Three providers will not do this at all</strong>, and each is named at the
						moment the address is typed rather than after a login fails. Microsoft retired password
						logins for IMAP outright. Google closed Workspace to app passwords in May 2025 while
						personal <code>@gmail.com</code> still takes one — nothing in the address says which of
						the two a company domain is, so the MX is checked. Proton's autoconfig honestly
						advertises <code>127.0.0.1:1143</code>, because the mail is only reachable through a
						bridge on your own desktop.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">The second line</span>
				<h2>Paste the password, then pair yourself</h2>
				<Screen>{`
/email abcd efgh ijkl mnop

scout is reached at agents+scout@fastmail.com.

Nobody may instruct scout by mail yet. Write to that address from wherever you read your own
mail, with this phrase anywhere in the message:

    kqm3nvbh27

Ask for something in that same mail if you like. scout reads whatever the phrase was written
around, so the first mail takes a turn like any other.

Whoever sends it is the one scout takes instructions from, and the only one: an address
strangers already have is one where every message read would spend a turn, so everyone
else's mail is left unread.
`}</Screen>
				<p>
					What makes the phrase mean anything is that a <code>From:</code> line is forgeable and the
					plane does not read one on its own. It reads the <code>Authentication-Results</code>{" "}
					header your own provider wrote at delivery time, when it checked DKIM and DMARC against
					the sending domain with that domain's keys as they were then. RFC 8601 has the receiving
					provider strip any foreign copy of that header on the way in, so the one left is the one
					it wrote.
				</p>
				<p>
					Telegram fences strangers and publishes them as participants. Mail does not: only the
					paired operator's is read, and everyone else's is dropped. A chat is a room someone let
					you into, while a mailbox is an address that leaks — every message read spends a turn, so
					publishing whatever arrived would put the plane's bill in the hands of whoever found it.
				</p>
			</section>

			<section>
				<span className="eyebrow">One account, every agent</span>
				<h2>The tag is the whole design</h2>
				<Screen>{`
scout is reached at agents+scout@fastmail.com. Write to it and scout takes a turn.

That is agents@fastmail.com on imap.fastmail.com:993, and it serves every agent on this plane:
each one is reached at its own name tagged onto the address, and mail arriving with no tag on
it comes here, to scout.

scout answers from that same address and under the same subject, so what it writes back
arrives in the thread you started and a reply to that comes back to the same agent.

Mail from you@example.com is read as instructions and nobody else's is read at all: an
address strangers already have is one where every message read would spend a turn.

/email off puts the mailbox down, for every agent.
`}</Screen>
				<p>
					<code>agents+scout@</code> and <code>agents+clerk@</code> are one account to the provider
					and two agents here, so an agent made tomorrow has an address without anybody going back
					to a settings page. Mail arriving with no tag goes to the agent the mailbox was connected
					at.
				</p>
				<p>
					The answer comes back from the tagged address rather than from the account, so a reply to
					it returns to the agent that wrote it. Some providers rewrite a <code>From</code> that is
					not the account they know, which is why the <code>Reply-To</code> says the same thing
					again: between the two, one survives.
				</p>
				<p className="small muted">
					It goes out twice over: as the markdown the agent wrote, and as the small piece of HTML
					that markdown describes — a mailbox is not a terminal, and an answer sent as it stands
					arrives reading <code>**Chiste #1:**</code> with a row of dashes under it. The drawing is
					done here rather than by a parser that lets HTML through, and everything is escaped on the
					way: an agent reads its mail, and a mail can tell it to write anything. Only{" "}
					<code>http</code>, <code>https</code> and <code>mailto</code> become links.
				</p>
			</section>

			<section>
				<span className="eyebrow">The way out</span>
				<h2>Somebody else can carry the mail</h2>
				<p>
					A submission server that refuses the same password is one reason. Volume is another — a
					consumer mailbox has a daily cap somewhere and does not tell you where — and knowing
					whether it landed is the third: a submission server accepts the message and the story ends
					there, while a company that carries mail for a living has an answer about every one.
				</p>
				<Screen>{`
│ config                                                         │
│                                                                │
│ One mailbox serves every agent: mail to you+scout@ is scout's  │
│ and mail to you+clerk@ is clerk's, so connecting this is a     │
│ thing done once, including for the agents that do not exist    │
│ yet.                                                           │
│                                                                │
│ Reading is IMAP, which wants no domain and nothing open on     │
│ this machine. Sending is either the mailbox's own server, or a │
│ company that carries mail for a domain of yours and says       │
│ whether it landed.                                             │
│                                                                │
│ ● mailbox   agents@fastmail.com                                │
│ ● carrier   Mailgun                                            │
│ ● domain    squad.dev                                          │
│ ● key       MAILGUN_API_KEY                                    │
`}</Screen>
				<p>
					Mailgun, Resend, Postmark and SendGrid each take a message over HTTP, and which one is a
					row on <Link href="/docs/config/">the config screen's</Link> <code>email</code> section.
					There is a dot for each half because the two halves fail for unrelated reasons: a mailbox
					nobody connected reaches nothing, and a carrier nobody paid for reads fine and cannot
					answer.
				</p>
				<p>
					Naming a carrier changes who hands the message over and nothing else. The{" "}
					<code>From</code> is still the agent's tagged address, the subject and message id of what
					came in are still kept, so a reply still comes back to the agent that wrote it. What
					changes is the reputation the message goes out on: your own provider's, which you already
					have, or a domain of yours at a carrier, which you warm up yourself.
				</p>
				<div className="note">
					<p>
						<strong>The carrier's key is not a proxy grant.</strong> The plane sends the mail, not
						the sandbox — there is no container on that path to write a header into — so the key
						stays in the same <code>0600</code> file every other provider key is typed into and is
						read at the moment of sending.
					</p>
				</div>
				<p className="small muted">
					<strong>Cloudflare belongs on the other side of this.</strong> Email Routing receives and
					forwards; it does not send. What it is good for is the half the plane was already doing by
					IMAP: point the MX for a domain of yours at Cloudflare, forward into the ordinary mailbox
					above, and the agents are reachable at your own domain. The tag does not survive a
					catch-all, though — a forward rewrites the delivery to the mailbox it was given, so
					reaching a particular agent through one takes a rule per agent addressed to that agent's
					tagged address.
				</p>
			</section>

			<section>
				<span className="eyebrow">What is not read</span>
				<h2>An inbox is mostly not for you</h2>
				<Screen>{`
09:14:02  email     dropped     not the operator ×212
09:14:02  email     dropped     no agent "billing" ×3
`}</Screen>
				<p>
					Anyone who is not the operator, anything auto-submitted, a tag that names no agent, and
					the mailbox's own mail — without that last one an agent Cc'd on its own answer would wake
					itself, read its own words as somebody's, and do it again. Drops are counted by reason
					rather than listed, because a mailbox declining two hundred newsletters is worth one line
					in the feed and is not worth two hundred.
				</p>
				<p className="small muted">
					The app password is a live credential and is treated like a bot token: never written into{" "}
					<code>config.yaml</code>, and redacted in the transcript by which command it was rather
					than by what it looked like — an app password is sixteen ordinary letters, and no pattern
					that catches one leaves a sentence alone. An agent may not run <code>/email</code>, for
					the reason it may not run <code>/telegram</code>: connecting a mailbox is choosing who may
					instruct it.
				</p>
			</section>
		</Docs>
	);
}
