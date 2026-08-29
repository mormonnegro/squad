import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Serve() {
	return (
		<Docs
			title="Publicar un puerto"
			lede="Un agente que escribe un frontend no tiene dónde ponerlo. La red del sandbox no está enrutada y esa es la idea, así que un servidor de desarrollo que arranque es un servidor de desarrollo que nadie puede abrir."
			description="/serve abre un puerto desde dentro del sandbox de un agente en la máquina donde está tu navegador, por el socket de control por el que la consola ya hablaba."
		>
			<section>
				<span className="eyebrow">La vía de entrada</span>
				<h2>Hacen falta dos máquinas para explicarlo, porque esto corre en dos</h2>
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
					El plano lleva el registro y la consola abre el listener, y esos no suelen ser el mismo
					equipo. Los agentes corren donde está el demonio de Docker — un VPS — y la consola es el{" "}
					<code>squad</code> de tu propio PATH. Así que el puerto sale en <em>tu</em> loopback, por
					el socket de control por el que la consola ya hablaba. No se publica nada en el servidor,
					no cambia ninguna regla de firewall, y el enlace muere cuando cerrás la consola en vez de
					quedarse abierto en una máquina que nadie mira.
				</p>
				<p>
					Dentro del sandbox va a <code>127.0.0.1</code>, que es la parte que vale la pena. Los
					sandboxes comparten una red y pueden llamarse entre sí por nombre de contenedor, así que
					un servidor atado a <code>0.0.0.0</code> es un servidor al que puede llegar cualquier otro
					agente del plano; un servidor en loopback es uno al que solo llega este. Al agente se le
					dice que ate el loopback, y el operador recibe el mismo enlace en cualquier caso.
				</p>
			</section>

			<section>
				<span className="eyebrow">Dos agentes, un 3000</span>
				<h2>El número cede, y el nombre dice de quién es</h2>
				<Screen>{`
> /serve
scout is serving:

  3000  http://scout.localhost:3000
  8080  http://scout.localhost:8081   (8080 is scribe's here)
`}</Screen>
				<p>
					<code>*.localhost</code> resuelve a loopback en todos los navegadores modernos sin nada
					configurado en ninguna parte. Dos agentes que ejecutan los dos un servidor de desarrollo
					aterrizan en 3000 sin que ninguno lo haya elegido, y una máquina tiene un solo 3000 — así
					que el número cede en vez de rechazar al segundo agente por algo que no hizo. El puerto de
					dentro del sandbox es el que el agente conoce y el que debe seguir usando; el puerto del
					enlace es el que hay que abrir, y por eso la respuesta nombra los dos.
				</p>
			</section>

			<section>
				<span className="eyebrow">Tu propia máquina tiene una opinión</span>
				<h2>Se llama al número antes de abrir una puerta</h2>
				<Screen>{`
✗ scout serve  could not open 3000 here — 127.0.0.1 in use. Something on this machine
               already answers there: free it, or have the agent bind another port
               inside and /serve that one.
`}</Screen>
				<p>
					Ceder resuelve a los agentes unos frente a otros, que es todo lo que el plano puede saber:
					la máquina en la que corre la consola es el equipo de alguien, con su propia idea de para
					qué es el 3000. Se llama en vez de atar, porque atar no rechaza de forma fiable — en BSD
					un servidor que ocupa <code>*:3000</code> y una puerta en <code>127.0.0.1:3000</code> son
					dos sockets para el kernel y ambas ataduras tienen éxito, y la más específica gana
					entonces todas las conexiones. La puerta se abriría, el propio servidor de desarrollo del
					operador dejaría de responder en silencio, y la razón sería un agente en el que no estaba
					pensando en ese momento.
				</p>
				<p className="small muted">
					El diagnóstico está en la respuesta y no en el log, porque un navegador abre seis
					conexiones a una página y un feed con seis fallos idénticos dentro es un feed que nadie
					lee. Pedir <code>/serve</code> sondea el puerto de dentro del sandbox en ese momento y
					dice si algo está escuchando, de modo que "el enlace está muerto" y "el servidor aún no
					está levantado" se distinguen donde la persona ya está mirando. <code>/serve stop</code>{" "}
					cierra la vía de entrada y nada más.
				</p>
				<p className="small muted">
					Un agente puede pedir esta, porque es la prueba de alcance leída al revés: abre una vía{" "}
					<em>de entrada</em> y no una de salida, desde una consola cuyo operador ya podría haber
					ejecutado lo que quisiera en ese sandbox. <Link href="/es/docs/console/">La consola</Link>{" "}
					tiene el resto de esa regla.
				</p>
			</section>
		</Docs>
	);
}
