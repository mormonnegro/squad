import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

const MCP: [string, string][] = [
	["/mcp", "lo que tiene este agente, y lo que hay en el estante"],
	["/mcp add <name> <url>", "encontrar uno una vez: va al estante, y este agente lo recibe"],
	["/mcp add <name> sse <url>", "lo mismo, para un servidor que habla el transporte antiguo"],
	[
		"/mcp add <name> <command …>",
		"un servidor que el agente arranca por su cuenta, dentro del sandbox",
	],
	["/mcp <name>", "dar a este agente uno que ya está en el estante"],
	["/mcp login <name>", "la pantalla de consentimiento, abierta en tu navegador"],
	["/mcp drop <name>", "quitarlo de este agente, y dejarlo en el estante"],
	["/mcp forget <name>", "quitarlo del estante, y de todos los agentes que lo tenían"],
	["/mcp logout <name>", "devolver la cuenta, para todos"],
];

export default function Mcp() {
	return (
		<Docs
			title="Servidores MCP"
			lede="Herramientas que viven en otra parte, registradas como propias de pi para que el modelo no pueda saber cuáles lo hacen. Encontrar un servidor es la parte cara, y solo tiene que ocurrir una vez."
			description="Añadir servidores MCP al estante que guarda el plano, dárselos a los agentes, iniciar sesión en los que quieren una cuenta y entender por qué ningún servidor guarda una credencial."
		>
			<section>
				<span className="eyebrow">Dónde está el cliente</span>
				<h2>Una extensión, en la imagen del sandbox</h2>
				<p>
					pi no tiene cliente MCP y lo dice a propósito: construye una extensión, responde su
					README. Así que <code>mcp.ts</code> está en la imagen del sandbox junto a{" "}
					<code>wake_me</code> y <code>web_search</code> y es uno completo — el handshake, los tres
					transportes, y las herramientas que vuelven registradas como propias de pi.
				</p>
			</section>

			<section>
				<span className="eyebrow">El estante</span>
				<h2>Encontrado una vez, repartido por nombre</h2>
				<Screen>{`
> /mcp add linear https://mcp.linear.app/mcp
"linear" is on the shelf, and this agent has it.

Any other agent can have it too, with /mcp linear.

> /mcp
This agent has:
  files   mcp-files /home/agent

On the shelf:
  linear  https://mcp.linear.app/mcp   (logged in)
  sentry  https://mcp.sentry.dev/mcp   (no grant)

/mcp linear gives this agent that one.
`}</Screen>
				<p>
					Una URL es un servidor remoto, <code>sse &lt;url&gt;</code> es uno que habla el transporte
					antiguo — lo único de un servidor que una línea no puede mostrar por sí sola — y cualquier
					otra cosa es un comando que el agente arranca por su cuenta. A partir del segundo agente
					es un nombre sacado de una lista, que es todo el sentido de que el estante sea del plano y
					no del agente.
				</p>
				<table className="table table-cmd">
					<tbody>
						{MCP.map(([cmd, what]) => (
							<tr key={cmd}>
								<td>{cmd}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					La lista se escribe en el sandbox antes de cada turno en vez de quedar fijada en el
					contenedor, así que un servidor añadido desde la consola llega a un agente que ya está
					levantado en su turno siguiente, y uno que se quita deja de ofrecerse.
				</p>
			</section>

			<section>
				<span className="eyebrow">Todo el estante de una vez</span>
				<h2>Y quién tiene qué</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ A server is something somebody went and found — a URL, a       │
│ command, the reading of a README — so the plane keeps it once  │
│ and every agent after the first is a name off this list.       │
│                                                                │
│ None of them holds a key. A remote one is reached through the  │
│ proxy like every other host, and one that wants an account is  │
│ logged into from an agent that has it, with /mcp login.        │
│                                                                │
│ ● linear  https://mcp.linear.app/mcp                           │
│ ○ notion  https://mcp.notion.com/mcp                           │
│ ● files   mcp-files /home/agent                                │
│   + a server                                                   │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ scout   (logged in)                                        │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					El punto significa lo que significa en la columna de agentes: algo que de verdad está
					alcanzando algo. Un servidor que no se le dio a nadie es una URL anotada —{" "}
					<code>notion</code> arriba — y encontrar eso es la pregunta que si no abrirías agente por
					agente para hacer. <code>⏎</code> da la fila que hay bajo el cursor al agente que nombra{" "}
					<code>tab</code>, y <code>⏎</code> otra vez la quita.
				</p>
			</section>

			<section>
				<span className="eyebrow">Cuentas</span>
				<h2>En un servidor no hay dónde poner una credencial</h2>
				<p>
					Uno local hereda un sandbox cuya única salida es{" "}
					<Link href="/es/docs/grants/">el proxy de egreso</Link>, a uno remoto se llega por ese
					mismo camino, y el proxy ya escribe la clave que cualquiera de los dos necesite. Así que
					conectarse a un servidor que quiere una cuenta siguen siendo dos cosas: la línea y una
					forma de entrar. Cuál no es una pregunta que el operador deba responder sacándola de un
					README, así que se le pregunta al servidor — <code>initialize</code> es lo que envía
					primero cualquier cliente, y un servidor que rechazaría al agente rechaza eso de forma
					idéntica.
				</p>
				<Screen>{`
> /mcp add notion https://mcp.notion.com/mcp
"notion" is on the shelf, and this agent has it.

It wants an account first: /mcp login notion
`}</Screen>
				<p>
					<code>/mcp login</code> registra un cliente, abre la pantalla de consentimiento en la
					consola — que es la máquina en la que está la persona, donde un plano dentro de un
					contenedor no está — y espera en el puerto 8788 a que vuelva el navegador. Un número y no
					uno por inicio de sesión, porque esa puerta tiene que publicarse fuera del contenedor de
					antemano; el despliegue la ata a loopback, y solo pasa un inicio de sesión a la vez. Donde
					ni siquiera eso se puede alcanzar, se puede pegar de vuelta la dirección en la que
					aterriza el navegador: <code>/mcp login notion &lt;address&gt;</code>.
				</p>
				<p>
					Lo que vuelve se guarda en el plano, <code>0600</code>, junto a la clave de la CA. El
					sandbox nunca ve un token, y el agente tampoco. La concesión que produce es un host, la
					ruta propia de ese servidor, y solo mientras el agente tenga el servidor —{" "}
					<code>/mcp drop</code> se lleva el alcance con él, y <code>/mcp logout</code> se lo quita
					a todos.
				</p>
				<div className="note">
					<p>
						<strong>
							Un inicio de sesión terminado es la única capacidad que no sale del archivo de
							configuración.
						</strong>{" "}
						Es deliberado y es estrecho: una pantalla de consentimiento es una persona leyendo un
						nombre de host y decidiendo, que es un acto de aprobación más fuerte que una línea de
						YAML y no más débil. Un agente puede pedir que esa pantalla se le ponga delante a su
						operador y no llega más lejos por pedirlo — lo que vuelve es la respuesta de una persona
						a una pregunta que se le mostró.
					</p>
				</div>
				<p className="small muted">
					Un servidor que no quiere cuenta y sigue fuera de alcance es el otro caso, y sigue siendo
					del operador: <code>/mcp</code> imprime la concesión para pegar pero no la escribe, porque
					dejar todo el alcance de un agente a una errata de distancia de la caja donde se escriben
					sus mensajes no es una comodidad.
				</p>
			</section>

			<section>
				<span className="eyebrow">Y al agente se le dice</span>
				<h2>Qué servidores tiene, en cada turno</h2>
				<Screen>{`
## The MCP servers you have

Read at the start of this turn. The operator adds and removes these between turns, so this is
the list that is true now — not whatever was said about them earlier in the conversation.

- \`ahrefs\` — connected. 134 tools, named \`ahrefs_*\`.
- \`notion\` — did not answer: HTTP 401: unauthorized
`}</Screen>
				<p>
					Tener las herramientas no es lo mismo que saber que llegaron. La respuesta de la consola a{" "}
					<code>/mcp login</code> va al operador, porque el operador es quien tiene el navegador en
					el que termina — así que a un agente que pidió un servidor nunca se le dice que lo
					consiguió. Solo tiene su lista de herramientas de la que deducirlo, y lo que hace en su
					lugar es recordar: el turno anterior le dijo al operador que el inicio de sesión estaba
					pendiente, así que este turno lo dice otra vez, sentado sobre cien herramientas que
					funcionan y que no va a tocar. El párrafo entra en cada turno y no una vez, porque el
					turno en el que la lista cambia es exactamente aquel cuyo historial dice lo contrario.
				</p>
				<p className="small muted">
					Un servidor que no responde le cuesta al agente las herramientas de ese servidor y no el
					turno, y se nombra en los dos sentidos: al agente, para que pueda informar de lo que dijo
					el servidor en vez de adivinar lo que al operador le queda por hacer, y al operador en el
					log — lo único que tiene que ir a arreglar no debería ser lo único que nadie le dice.
				</p>
			</section>
		</Docs>
	);
}
