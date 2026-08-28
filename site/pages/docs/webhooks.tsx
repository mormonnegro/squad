import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";

export default function Webhooks() {
	return (
		<Docs
			title="Webhooks"
			lede="Port 8787 is the one thing published, and it takes signed requests only. A webhook wakes an agent; it never tells it what to do."
			description="Wake an agent from anything that can make an HTTP request: declare a hook, sign the body, and know why a webhook can never carry operator trust."
		>
			<section>
				<span className="eyebrow">Declared, not discovered</span>
				<h2>A hook is a block in the config file</h2>
				<Code label="deploy/config.yaml">{`
hooks:
  - id: deploys
    agentId: scout
    # The name of an environment variable, not the secret itself.
    secretEnv: DEPLOY_HOOK_SECRET
    # The default is "public". A hook may never be "operator".
    trust: participant
    replyUrl: https://acme.example.com/agent-replies
`}</Code>
				<p>
					That makes <code>POST /hooks/deploys</code> exist and belong to <code>scout</code>. The
					secret is named rather than written, so the file describing what can wake your agents
					stays committable and diffable. <code>replyUrl</code> is where the agent's answer is
					posted back, for a system that wants one.
				</p>
				<p className="small muted">
					The installer writes a working hook and generates its secret into <code>.env</code>, so
					there is one to try before you have written any of this.
				</p>
			</section>

			<section>
				<span className="eyebrow">Sending one</span>
				<h2>The signature covers the timestamp and the body</h2>
				<Code wrap>{`
BODY='{"text":"the nightly build failed"}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$DEPLOY_HOOK_SECRET" -r | cut -d' ' -f1)"

curl -X POST http://localhost:8787/hooks/deploys \\
  -H "x-squad-timestamp: $TS" \\
  -H "x-squad-signature: $SIG" \\
  -d "$BODY"
`}</Code>
				<p>
					It is compared in constant time within a freshness window. An unknown hook id answers
					exactly like a bad signature, and only after the body has been read, so the endpoint does
					not enumerate — someone holding no secret cannot learn from it which hooks exist.
				</p>
			</section>

			<section>
				<span className="eyebrow">What arrives</span>
				<h2>Authentic, and still written by anyone</h2>
				<p>
					A GitHub webhook is signed by GitHub and relays an issue body typed by a stranger. So a
					webhook may not carry <Link href="/docs/trust/">operator trust</Link>, however well
					signed: the secret proves which system sent the request, never that a human meant what is
					inside it. The body arrives fenced, introduced as data, with a random nonce chosen after
					the content is written so that nothing inside can close the fence.
				</p>
				<p>
					Events queue per agent and are folded into a single turn, so an agent woken twenty times
					while busy takes one turn about twenty things. A turn that fails leaves its events queued
					rather than acknowledging them, so a bad API key costs a retry instead of the message.
				</p>
				<p className="small muted">
					The reply is routed by the channel of the event that caused it, so an agent answering a
					GitHub hook cannot be steered into replying on Telegram by anything in the payload.
				</p>
			</section>

			<section>
				<span className="eyebrow">The other two ways in</span>
				<h2>Neither of them needs a port</h2>
				<p>
					<Link href="/docs/telegram/">Telegram</Link> and <Link href="/docs/email/">email</Link>{" "}
					reach out rather than being reached, so neither costs a domain, a certificate or anything
					published. They are also the two that can be paired to a person, which is what lets them
					instruct. If nothing needs to wake your agents from outside, port 8787 is a thing you
					never open.
				</p>
			</section>
		</Docs>
	);
}
