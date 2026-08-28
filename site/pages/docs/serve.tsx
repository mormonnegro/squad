import Link from "next/link";
import { Docs } from "../../components/Docs";
import { Screen } from "../../components/Screen";

export default function Serve() {
	return (
		<Docs
			title="Serving a port"
			lede="An agent that writes a frontend has nowhere to put it. The sandbox network is unrouted and that is the point, so a dev server it starts is a dev server nobody can open."
			description="/serve opens a port from inside an agent's sandbox on the machine your browser is on, over the control socket the console was already talking on."
		>
			<section>
				<span className="eyebrow">The way in</span>
				<h2>It takes two machines to explain, because this runs on two</h2>
				<Screen>{`
> /serve 3000
scout is serving 3000

  http://scout.localhost:3000

Nothing is listening on 3000 inside the sandbox yet. The link waits: it starts working the
moment something binds that port in there, with nothing to type here.

A console is what opens these, on the machine it is running on. They are reachable from
there and from nowhere else: nothing is published off the server, and the sandbox network
is still as unrouted as it was.
`}</Screen>
				<p>
					The plane keeps the record and the console opens the listener, and those are usually not
					the same computer. Agents run where the Docker daemon is — a VPS — and the console is the{" "}
					<code>squad</code> on your own PATH. So the port comes out on <em>your</em> loopback, over
					the control socket the console was already talking on. Nothing is published on the server,
					no firewall rule changes, and the link dies when you close the console rather than staying
					open on a machine nobody is looking at.
				</p>
				<p>
					Inside the sandbox it goes to <code>127.0.0.1</code>, which is the part worth having.
					Sandboxes share one network and can dial each other by container name, so a server bound
					to <code>0.0.0.0</code> is a server every other agent on the plane can reach; a server on
					loopback is one only this reaches. The agent is told to bind loopback, and the operator
					gets the same link either way.
				</p>
			</section>

			<section>
				<span className="eyebrow">Two agents, one 3000</span>
				<h2>The number gives way, and the name says whose it is</h2>
				<Screen>{`
> /serve
scout is serving:

  3000  http://scout.localhost:3000
  8080  http://scout.localhost:8081   (8080 is scribe's here)
`}</Screen>
				<p>
					<code>*.localhost</code> resolves to loopback in every modern browser with nothing
					configured anywhere. Two agents both running a dev server land on 3000 without either of
					them having chosen it, and one machine has one 3000 — so the number gives way rather than
					the second agent being refused for something it did not do. The port inside the sandbox is
					the one the agent knows about and should keep using; the port in the link is the one to
					open, which is why the answer names both.
				</p>
			</section>

			<section>
				<span className="eyebrow">Your own machine has an opinion</span>
				<h2>The number is knocked on before a door is opened</h2>
				<Screen>{`
✗ scout serve  could not open 3000 here — 127.0.0.1 in use. Something on this machine
               already answers there: free it, or have the agent bind another port
               inside and /serve that one.
`}</Screen>
				<p>
					Giving way settles the agents against each other, which is all the plane can know: the
					machine the console runs on is somebody's laptop, with its own idea of what 3000 is for.
					Knocked on rather than bound, because a bind does not reliably refuse — on BSD a server
					holding <code>*:3000</code> and a door on <code>127.0.0.1:3000</code> are two sockets to
					the kernel and both binds succeed, the more specific one then winning every connection.
					The door would open, the operator's own dev server would quietly stop answering, and the
					reason would be an agent they were not thinking about at the time.
				</p>
				<p className="small muted">
					The diagnosis is in the answer rather than in the log, because a browser opens six
					connections to a page and a feed with six identical failures in it is a feed nobody reads.
					Asking for <code>/serve</code> probes the port inside the sandbox at that moment and says
					whether anything is listening, so "the link is dead" and "the server is not up yet" are
					told apart where the person is already looking. <code>/serve stop</code> closes the way in
					and nothing else.
				</p>
				<p className="small muted">
					An agent may ask for this one, because it is the reach test read the other way round: it
					opens a way <em>in</em> rather than a way out, from a console whose operator could already
					have run anything they liked in that sandbox.{" "}
					<Link href="/docs/console/">The console</Link> has the rest of that rule.
				</p>
			</section>
		</Docs>
	);
}
