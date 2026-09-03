import Link from "next/link";
import { Code } from "../../components/Code";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Repos() {
	return (
		<Docs
			title="Repositories"
			lede="A grant on a repository host with a token on it is a grant to push anywhere on the repository, main included. So a repository is given together with the branches that go with it, and the proxy reads every push before it passes one."
			description="How /repo works: four words that become three grants, the branches an agent may push, a push to main turned down in git's own words, and the token the agent never holds."
		>
			<section>
				<span className="eyebrow">Giving one</span>
				<h2>Four words, three grants</h2>
				<Screen>{`
│ › /repo acme/website                                             │
│   This plane holds no GitHub token. Make a fine-grained one at   │
│   https://github.com/settings/personal-access-tokens/new with    │
│   Contents: read and write on acme/website — and Pull requests:  │
│   read and write, if it should open them — then paste it here:   │
│   /repo github_pat_…                                             │
│                                                                  │
│   It is kept here, spent by the proxy, and never given to an     │
│   agent.                                                         │
│                                                                  │
│ › /repo …                                                        │
│   scout holds https://github.com/acme/website. It can clone it   │
│   and push to scout/*; a push to any other branch is refused     │
│   before it leaves, and it can open pull requests. The token     │
│   stays here, never in the sandbox.                              │
`}</Screen>
				<p>
					What the plane derives from <code>acme/website</code> is three grants, none of them
					written by hand: <code>github.com</code> under <code>/acme/website</code>, with the push
					scope on it and the token attached as basic auth, which is the clone and the push;{" "}
					<code>api.github.com</code> under <code>/repos/acme/website</code> for <code>GET</code>,
					which is reading; and under <code>/repos/acme/website/pulls</code> for <code>POST</code>{" "}
					and <code>PATCH</code> as well, which is opening a pull request. Two API grants rather
					than one because the API is where a branch scope could be walked around — a{" "}
					<code>PUT</code> on <code>contents/</code> commits to any branch, a <code>PATCH</code> on{" "}
					<code>git/refs/</code> moves any ref, a <code>POST</code> on <code>merges</code> merges
					into main. Opening a PR is the one write it gets; merging one is a <code>PUT</code> it is
					not given.
				</p>
				<p className="small muted">
					The token is the plane's, one for every repository given here, kept beside the provider
					keys as <code>GITHUB_TOKEN</code> — exporting it in the plane's environment works too, and
					what is pasted at a console wins. A fine-grained token answers only for the repositories
					it was given, so give it the ones you will hand out and nothing else: it is the belt under
					the proxy's scope, not a second copy of it. The repository answers under its name with{" "}
					<code>.git</code> on the end as well as without, because the agent pastes whichever the
					clone box showed it.
				</p>
			</section>

			<section>
				<span className="eyebrow">The branches</span>
				<h2>Its own lane, unless you say otherwise</h2>
				<p>
					Left unsaid, the branches are the agent's own name and anything under it —{" "}
					<code>scout/*</code> — so nothing lands on main because nobody said which branches.{" "}
					<code>/repo acme/website fix/* docs</code> names them instead. A pattern is shaped like a
					refspec: a bare name is a branch, <code>*</code> stands for anything, slashes included,
					and <code>*</code> on its own is anywhere at all. Saying <code>/repo</code> again for a
					repository already held changes what it may push rather than adding a row.
				</p>
				<Screen>{`
│ $ git push origin main                                                 │
│ remote: squad: main is not granted to this agent; push scout/* here    │
│ To https://github.com/acme/website                                     │
│  ! [remote rejected] main -> main (not granted: push scout/* here)     │
│ error: failed to push some refs to 'https://github.com/acme/website'   │
`}</Screen>
				<p>
					The branch is in the head of the push itself: one line per ref, closed by a flush, and the
					packfile after. The proxy reads to the flush before it opens anything upstream, and if a
					ref is not on the list nothing goes — not the packfile, not the other refs pushed with it.
					The refusal is not a 403, because a 403 reaches git as <code>RPC failed; HTTP 403</code>,
					which is what a wrong token looks like, and an agent reading that goes and checks its
					token. What git prints word for word is the server's report, so the proxy declines the way
					a pre-receive hook does, naming the branch it refused and the ones it has. The audit log
					carries the refs of every push, allowed or not.
				</p>
			</section>

			<section>
				<span className="eyebrow">What the agent is told</span>
				<h2>Said every turn, after the house rules</h2>
				<p>
					A grant nobody mentions is a grant found by trial — cloning under the wrong name and
					meeting a 403, or pushing to main and meeting a refusal it did not know was coming. So the
					plane tells the agent what it holds at the start of every turn, the way it says the{" "}
					<Link href="/docs/agents/">house rules</Link>: the URL, where under its workspace the
					checkout goes, and the branches it may push. Its commits carry its own name, and git in
					the sandbox never stops to ask for a password, since the credential is put on by the proxy
					and a prompt would be a turn hung on a question nobody answers.
				</p>
				<Screen>{`
│ › /repo                                                                │
│   scout holds:                                                         │
│     https://github.com/acme/website  push scout/*     from here        │
│     https://github.com/acme/api      push fix/* docs  from the file    │
│                                                                        │
│   /repo drop <owner/name> takes one back; /repo <owner/name>           │
│   <branch>… changes what it may push.                                  │
`}</Screen>
				<p className="small muted">
					An agent may ask <code>/repo</code> to see what it holds, and may not ask to hold one:
					holding a repository spends your token on it, and a token an agent is holding is one it
					got from something it read. The refusal says which line is yours to type, and never prints
					the token.
				</p>
			</section>

			<section>
				<span className="eyebrow">What it does not claim</span>
				<h2>A force push looks like a push</h2>
				<p>
					The proxy sees the refs and not the history behind them, so a force push to a branch the
					agent may push passes, and so does deleting one. Nothing about main changes hands either
					way, and that is the claim: the branches you named are the branches it can touch. The
					second belt is GitHub's, a ruleset on main that refuses direct pushes, with a bypass for
					you — worth having because the token is the plane's and lives outside the sandbox, where
					the proxy is not what guards it.
				</p>
				<p>
					The same four words go in <code>deploy/config.yaml</code>, under the agent, and what the
					file declares the console leaves to the file:
				</p>
				<Code label="deploy/config.yaml">{`
agents:
  - id: scout
    repos:
      - repo: acme/website
      - repo: acme/api
        push: [fix/*, docs]
`}</Code>
				<p className="small muted">
					<Link href="/docs/grants/">Reach</Link> is what a grant is and where the credential sits,
					and this is one shape of grant with a scope the method could not carry.
				</p>
			</section>
		</Docs>
	);
}
