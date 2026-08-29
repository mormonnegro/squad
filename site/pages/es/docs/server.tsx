import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";
import { INSTALL } from "../../../lib/site";

const HOSTS: [string, string, string][] = [
	[
		"Hetzner",
		"https://www.hetzner.com/cloud",
		"the most machine for the money — around €4.50 buys two cores and 4 GB, in Europe and the US",
	],
	[
		"Linode",
		"https://www.linode.com/pricing/",
		"$5 for one core and 1 GB, in eleven regions, and the plainest create screen of the four",
	],
	[
		"Vultr",
		"https://www.vultr.com/pricing/",
		"from about $5, and in more places than the other three put together",
	],
	[
		"DigitalOcean",
		"https://www.digitalocean.com/pricing/droplets",
		"a few dollars more, and the most written about — worth it if this is your first server",
	],
];

const FORM: [string, string][] = [
	[
		"region",
		"Where the machine physically is. Latency does not matter here — nobody is typing at this thing, and an agent that wakes at three in the morning does not care about forty milliseconds. Pick the country whose law you would rather your data sat under, or the one nearest you, and move on.",
	],
	[
		"image",
		"The operating system. Ubuntu LTS or Debian stable, and this page assumes one of those. Anything with SSH and a package manager works; the installer brings Docker itself, so a picture that already says Docker on it buys you nothing.",
	],
	[
		"size",
		"The bottom of the list. One vCPU, a gigabyte of memory and ten gigabytes of disk runs a few agents — that is the cheapest row on every provider's page, and the one to click.",
	],
	[
		"authentication",
		"An SSH key, or a root password. This is the only row on the form worth stopping at, and the next section is the whole of it.",
	],
	[
		"the rest",
		"Backups, monitoring, private networking, a floating IP, a firewall. All off. None of them is needed to start and each is a line on the bill.",
	],
];

export default function Server() {
	return (
		<Docs
			title="A server"
			lede="Agents are containers, and containers need a machine that stays on. The cheapest row on any provider's list is enough, and every one of those providers asks you the same five questions under different names."
			description="Rent a five-dollar VPS at any host, get into it with an SSH key or the root password, and put the plane on it."
		>
			<section>
				<span className="eyebrow">Why there is a machine at all</span>
				<h2>Something has to be awake when you are not</h2>
				<p>
					An agent that wakes at nine on a weekday, or the moment a build fails, is an agent on a
					computer that did not go to sleep with the lid. That is the whole argument for a server,
					and it is why the requirement is so small: this is a machine that idles nearly all the
					time and thinks in bursts, and the thinking happens at whichever model provider you gave a
					key to rather than here.
				</p>
				<p>
					So the bottom of every list runs it.{" "}
					<strong>One vCPU, a gigabyte of memory, ten gigabytes of disk</strong>, any Linux with SSH
					on it. The installer brings Docker if the machine has none. An old laptop under the desk
					does just as well, and so does a machine at work you can reach — nothing below is specific
					to renting.
				</p>
			</section>

			<section>
				<span className="eyebrow">Where to buy one</span>
				<h2>Four that are cheap, and the difference between them is not squad</h2>
				<table className="table">
					<tbody>
						{HOSTS.map(([who, href, what]) => (
							<tr key={who}>
								<td>
									<a href={href}>{who}</a>
								</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					Prices move, so read those as the shape rather than the quote. What does not move is the
					shape of the bill: the machine is a flat monthly number, and the only other cost is what
					the agents think with — metered by the model provider, and capped by{" "}
					<Link href="/es/docs/limits/">limitUsd</Link> at five dollars a day per agent until you
					say otherwise. There is nothing to pay for squad itself.
				</p>
			</section>

			<section>
				<span className="eyebrow">The create screen</span>
				<h2>Five questions, wearing four sets of names</h2>
				<p>
					Every provider's form is the same form. Hetzner calls the machine a Cloud Server, Linode
					calls it a Linode, DigitalOcean calls it a Droplet and Vultr calls it an Instance, and
					underneath the words they ask you this:
				</p>
				<table className="table">
					<tbody>
						{FORM.map(([field, what]) => (
							<tr key={field}>
								<td>{field}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p>
					A minute after you click create there is an IP address on the screen. That address, and a
					way in, is everything squad needs from this provider — nothing here has to be configured
					for it, and no port has to be opened.
				</p>
			</section>

			<section>
				<span className="eyebrow">The row worth stopping at</span>
				<h2>A key and a password are both ways in, and one is not worse</h2>
				<p>
					A key is a file on your computer that the server recognises. A password is a string the
					provider mails you or shows you once. Both get you in, both are what squad rides, and the
					real difference is that a password has to be typed again and a key does not.
				</p>
				<p>
					<strong>If the form offers to take a key</strong>, give it one. Yours is probably already
					there, and this prints it:
				</p>
				<Code>{`
$ cat ~/.ssh/id_ed25519.pub
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… you@your-laptop
`}</Code>
				<p>
					<code>No such file or directory</code> means this computer has never spoken SSH, which is
					not unusual and is one command to fix:
				</p>
				<Code>{`
$ ssh-keygen -t ed25519
`}</Code>
				<p className="small muted">
					Press return through its questions. It writes two files — <code>id_ed25519</code>, which
					is the secret and never leaves this computer, and <code>id_ed25519.pub</code>, which is
					the line you paste into the provider's box. An older machine may have{" "}
					<code>id_rsa.pub</code> instead; that works too.
				</p>
				<p>
					<strong>If it does not, or you would rather not</strong>, take the root password. A server
					bought this morning with a password in an email is a perfectly good starting point, and
					squad expects exactly that case — the next section is what it does about it.
				</p>
			</section>

			<section>
				<span className="eyebrow">And then squad asks</span>
				<h2>One address, and it finds out the rest by trying</h2>
				<Screen>{`
Where should your agents live?

  1  On this computer   a container here, and Docker is what runs it
  2  On a server        a machine you have SSH to. A $5 VPS is enough

  1 or 2  2

Which machine?
  Anything ssh can reach. The prompt already reads root@, so a bare host finishes it.
  An empty line says you have not got one yet.

  root@203.0.113.9
`}</Screen>
				<p>
					The prompt already reads <code>root@</code>, so the IP address the provider just gave you
					finishes it. A name works as well as an address, and so does a host out of your{" "}
					<code>~/.ssh/config</code> — anything <code>ssh</code> can reach. An empty line is the
					answer for somebody who has not bought one yet, and prints the list above rather than an
					error.
				</p>
				<p>
					What happens next is one connection that tries the key and nothing else. If the machine
					takes it, that connection is the one the install and the console then ride, and you were
					never asked anything. If it turns the key down, there are exactly two things to do about
					it and you are asked which:
				</p>
				<Screen>{`
203.0.113.9 does not take this computer's key.

  1  Put one up         appends it to authorized_keys, and nothing asks again
  2  Keep the password  asked once per connection, and one lasts ten idle minutes

  1 or 2
`}</Screen>
				<p>
					<strong>Put one up</strong> spends the password once. Your public key goes up on the same
					connection the password opens, appended to <code>authorized_keys</code> and nothing else
					touched, and nothing after that asks — not the install, not the console, not a port
					forwarded out of a sandbox later. Run it a second time and a key already in the file is
					left where it is.
				</p>
				<p>
					<strong>Keep the password</strong> is a real answer and not the consolation. It is asked
					once per connection, and a connection lasts ten idle minutes, so it is typed about as
					often as you walk away from the machine — and never in the middle of anything, because the
					connection is always opened first, on a bare terminal, before the console is drawn.
				</p>
				<div className="note">
					<p>
						<strong>The question is asked as a preference, because it is one.</strong> A key does
						not appear on your server because the program preferred it, and a password is not
						treated as the weaker way in. Where the connection dies of something else — a name that
						does not resolve, a host key that changed — you get what <code>ssh</code> said rather
						than a password prompt on top of it.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">What lands there</span>
				<h2>One script, and nothing of the console stays behind</h2>
				<p>
					The console pipes a single shell script down that connection. It installs Docker if there
					is none, puts the repository in <code>/opt/squad</code>, writes a config with one agent
					and a ceiling of five dollars a day, starts the plane and leaves <code>squad</code> on
					that machine's PATH. Then it drops you on the console, here, on your own computer.
				</p>
				<p>
					That script stands alone, and running it at the server's own terminal is the same install
					with the questions it can only ask when somebody is there to answer:
				</p>
				<Code label="on the server" wrap>{`
$ curl -fsSL ${INSTALL} | sh
`}</Code>
				<p className="small muted">
					Running it again is the update — it pulls, rebuilds and swaps the plane in, and never
					touches <code>config.yaml</code> or <code>.env</code>. <code>squad update</code> does that
					from your own keyboard, on whichever machine the plane is on.
				</p>
			</section>

			<section>
				<span className="eyebrow">What not to open</span>
				<h2>There is no port, so there is no firewall to write</h2>
				<p>
					The control surface is a unix socket in the state directory and it never leaves the
					machine. Nothing is published, nothing listens for you, and there is no account to make or
					token to issue: SSH already decides who may touch that host, and touching that host is the
					whole of what holding the socket means. So the provider's firewall can stay exactly as
					their default left it.
				</p>
				<p>
					The one exception is deliberate and you opt into it.{" "}
					<Link href="/es/docs/webhooks/">Webhooks</Link> publish port <code>8787</code>, which
					takes signed requests only — and you only need it if something on the internet has to be
					able to wake an agent. Telegram and mail need nothing published at all, because they reach
					out rather than being reached.
				</p>
				<div className="note">
					<p>
						<strong>Why there is no web UI to log into.</strong> The control plane holds the Docker
						socket, so it is root-equivalent on the machine — the trust boundary is the sandbox
						around the agent, not the process managing it. Publishing that control surface would be
						putting root on the internet behind a password somebody chose.{" "}
						<Link href="/es/docs/trust/">Trust</Link> has the rest of what that does and does not
						claim.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">If you change your mind</span>
				<h2>The answer is remembered, and one command moves it</h2>
				<p>
					Where the agents live is asked once and kept in <code>~/.squad/plane.json</code>.{" "}
					<code>squad connect</code> asks again — so a plane that started on your laptop moves to a
					server you bought later, and a server you are done with is replaced by another, without
					reinstalling the console.
				</p>
				<p className="small muted">
					Everything after that question is the same program. A plane answers the same protocol
					whether its socket is in a directory on this computer or at the far end of an SSH
					connection, which is why <Link href="/es/docs/console/">the console</Link>,{" "}
					<Link href="/es/docs/serve/">a forwarded port</Link> and the log feed all behave
					identically either way.
				</p>
			</section>
		</Docs>
	);
}
