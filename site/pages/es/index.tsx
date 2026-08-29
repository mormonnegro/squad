import Link from "next/link";
import type { ReactNode } from "react";
import { Code } from "../../components/Code";
import { Console } from "../../components/Console";
import { Feed, type FeedRow } from "../../components/Feed";
import { Layout } from "../../components/Layout";
import { Screen } from "../../components/Screen";
import { CLIENT, REPO } from "../../lib/site";

// La versión española de TAGLINE en lib/site.ts. El hero lee esto y la meta description también,
// porque una página que se describe de una manera al lector y de otra al buscador está describiendo
// dos proyectos distintos.
const TAGLINE =
	"Agentes en la nube, en una máquina que es tuya. Dale a uno un trabajo permanente: se despierta solo, lo hace y te escribe.";

const FEED: FeedRow[] = [
	{ at: "18:12:53", who: "builds", action: "bash", detail: "pnpm -r test" },
	{
		at: "18:12:53",
		who: "builds",
		action: "bash",
		failed: true,
		detail: "after 12.4s: FAIL test/turn.test.ts > carries the failure detail",
	},
	{ at: "18:12:53", who: "builds", action: "read", detail: "packages/control-plane/src/turn.ts" },
	{
		at: "18:12:53",
		who: "tickets",
		action: "egress",
		failed: true,
		detail: "denied GET api.github.com/repos — no_matching_host",
	},
	{ at: "18:12:53", who: "builds", action: "answer", detail: "The test asserted the old message." },
	{
		at: "18:12:53",
		who: "builds",
		action: "spent",
		detail: "1m38s · 91.2k tokens · $0.02 · api.deepseek.com ×12",
	},
];

// Lo que alguien le encarga de verdad, con las palabras que usaría. Cada línea es un trabajo
// permanente y no una demo: la primera pregunta que responde esta página es para qué tener uno.
const JOBS: [string, ReactNode][] = [
	[
		"vigilar un repositorio",
		<>
			Un check se pone en rojo. Lee el fallo, lo arregla, hace push y cuenta lo que hizo en el pull
			request — mientras tú almorzabas.
		</>,
	],
	[
		"seguir a un rival",
		<>
			Cada lunes a las ocho: tres páginas de precios, tres changelogs. Recibes un correo, y es lo
			que se movió.
		</>,
	],
	[
		"un encargo largo",
		<>
			<em>Despliega cuando CI se ponga en verde</em> no es un turno. Comprueba, se reserva otro
			turno, y te escribe cuando está en producción.
		</>,
	],
	[
		"montar guardia",
		<>
			Una URL cada diez minutos, un certificado que caduca. El mensaje llega desde una máquina que
			no es la que se cayó.
		</>,
	],
	[
		"un mostrador donde preguntar",
		<>
			Escríbele un correo, o mensajea a su bot desde el aeropuerto. Tiene el repositorio, las
			herramientas y cuatro meses de lo que le contaste.
		</>,
	],
];

const SELF: [string, string][] = [
	["soul.md", "quién es; se añade al prompt en cada turno"],
	["memory/", "lo que eligió recordar"],
	["skills/", "cómo se hacen aquí las cosas, escrito una sola vez"],
	["tools/", "scripts que se escribió a sí mismo"],
	["agent.yaml", "las capacidades que le pide a un operador"],
];

const CHANNELS: [string, ReactNode][] = [
	[
		"email",
		<>
			Un buzón para todo el plano, conectado con <code>/email</code>. Cada agente tiene su propia
			dirección dentro — <code>agents+scout@…</code> — y responde en el hilo.
		</>,
	],
	[
		"telegram",
		<>
			Un bot por agente: el token en <code>/telegram</code>, y tu teléfono es donde se escriben los
			encargos de una línea.
		</>,
	],
	[
		"webhook",
		<>
			Para sistemas y no para personas: GitHub, un despliegue, cualquier cosa que firme una
			petición.
		</>,
	],
];

const SLASH: [string, string][] = [
	["/limit", "lo que lleva gastado hoy, y el techo que tiene"],
	["/model", "con qué piensa, y qué más hay"],
	["/mcp", "los servidores MCP que tiene, y el estante desde el que añadir"],
	["/serve", "un puerto de dentro, en la máquina en la que estás sentado"],
	["/telegram", "el bot en el que responde, y cómo emparejar uno"],
	["/email", "la dirección en la que se le encuentra, y cómo conectar un buzón"],
];

const COMMANDS: [string, string][] = [
	["squad chat demo", "hablar con uno en el scrollback, turno tras turno"],
	["squad ls", "qué es cada agente y si está levantado"],
	['squad wake "check the open issues"', "tomar un turno, y esperar la respuesta"],
	["squad logs", "seguir lo que cada agente ejecuta, responde y gasta"],
	["squad rm demo --purge", "el sandbox, y con --purge el repositorio que hay dentro"],
];

const PROBLEMS: { problem: string; body: ReactNode; rule: string }[] = [
	{
		problem: "Un agente desatendido lee lo que escriben desconocidos",
		body: (
			<>
				Un webhook de GitHub es auténtico y aun así retransmite el cuerpo de un issue escrito por
				cualquiera. Todo lo que no vino de ti llega delimitado, como datos.
			</>
		),
		rule: "Solo un operador da instrucciones.",
	},
	{
		problem: "Una credencial se puede gastar en cualquier parte",
		body: (
			<>
				Así que el agente nunca tiene ninguna. Aquello a lo que llega sale por un proxy que
				comprueba la petición contra lo que aprobaste y añade el secreto después. A un agente al que
				convencen de mandarte su clave no le queda nada que mandar.
			</>
		),
		rule: "El agente nunca ve una clave.",
	},
	{
		problem: "Un agente puede editar su propia definición",
		body: (
			<>
				Es dueño de su repositorio, y una línea dentro es una petición. Lo que puede alcanzar se
				responde en un archivo que no puede escribir.
			</>
		),
		rule: "Nada de lo que diga puede concederle nada.",
	},
];

export default function Home() {
	return (
		<Layout description={TAGLINE}>
			<section className="hero">
				<div className="wrap">
					<h1>squad</h1>
					<p className="lede">{TAGLINE}</p>
					<div className="hero-install">
						<Code label="en tu equipo" wrap>{`
$ curl -fsSL ${CLIENT} | sh
$ squad
`}</Code>
						<p className="small muted">
							Puedes elegir dónde viven tus agentes: en tu propia computadora o en la nube. Es lo
							primero que pregunta — este equipo, o un servidor al que tengas SSH. Con un VPS de $5
							alcanza para unos cuantos.
						</p>
					</div>
				</div>
				<div className="wrap-wide hero-console">
					<Console />
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Para qué tener uno</span>
					<h2>Un trabajo permanente, y va y lo hace</h2>
					<table className="table">
						<tbody>
							{JOBS.map(([job, what]) => (
								<tr key={job}>
									<td>{job}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="small muted">
						Un agente por trabajo — la columna de la izquierda de esa consola. Hacer el siguiente es
						un nombre y <code>⏎</code>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Dónde trabaja</span>
					<h2>Su propia máquina, y root en ella</h2>
					<p>
						Cada agente recibe una caja propia. Puede bajarse un toolchain a las tres de la mañana,
						ejecutar tu suite de tests cuarenta veces y llenar el disco con una compilación mala —
						tu equipo no está en el radio de la explosión, y el agente de al lado tampoco. Eso es lo
						que hace que valga la pena darle trabajo de verdad: no describe el arreglo, hace el
						arreglo y ejecuta los tests.
					</p>
					<p>
						Dos cosas sobreviven al contenedor. <code>~/workspace</code> guarda tus proyectos, y{" "}
						<code>~/.self</code> es el agente mismo — un repositorio git del que es dueño:
					</p>
					<table className="table">
						<tbody>
							{SELF.map(([file, what]) => (
								<tr key={file}>
									<td>{file}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p>
						<code>tools/</code> es el que hay que mirar dos veces. Un agente que ha llamado tres
						veces desde la shell a algo incómodo se escribe un script para la cuarta, y el viernes
						es mejor en tu trabajo de lo que era el lunes.
					</p>
					<p className="small muted">
						<code>!</code> abre una shell en esa misma caja, y <code>/serve 3000</code> saca un
						puerto de ahí a la máquina en la que está tu navegador.{" "}
						<Link href="/es/docs/agents/">Agentes</Link> es la versión larga.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Mientras duermes</span>
					<h2>Se reserva su propio turno siguiente, y el día tiene un techo</h2>
					<p>
						Dos relojes. Uno que escribiste tú — cron, en una zona horaria que nombras. Uno que se
						pone él mismo: <code>wake_me</code> pide otro turno dentro de tres minutos o tres días y
						deja una nota para la versión de sí mismo que se despierte. Por eso un trabajo largo es
						algo que puedes delegar en vez de algo que hay que aguantar sentado.
					</p>
					<Screen>{`
> /limit 5
Spending limit set to $5.00 a day. $0.42 spent today, of $5.00 a day.
`}</Screen>
					<p>
						Un agente que corre sin nadie mirando tiene un techo en dólares al día. Alcanzarlo
						detiene el turno siguiente y no el que está en curso. Un agente puede pedir que se le
						limite a menos; no llega a ninguna parte pidiendo más.
					</p>
					<p className="small muted">
						Con qué piensa es un comando y no un redespliegue. La clave es tuya y la factura es de
						tu proveedor — aquí no hay cuenta que sostenga ninguna de las dos.{" "}
						<Link href="/es/docs/schedules/">Horarios</Link>,{" "}
						<Link href="/es/docs/limits/">gasto</Link> y{" "}
						<Link href="/es/docs/models/">modelos</Link>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Estar localizable</span>
					<h2>Tiene una dirección y un teléfono</h2>
					<table className="table">
						<tbody>
							{CHANNELS.map(([name, what]) => (
								<tr key={name}>
									<td>{name}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p>
						Una respuesta vuelve por donde entró la petición. Telegram y el correo se pueden
						emparejar con una persona, y lo que esa persona escribe es una instrucción. A todos los
						demás se les oye, se les cita y no se les obedece.
					</p>
					<p className="small muted">
						Ninguno de los tres cuesta un dominio, un certificado ni un puerto abierto.{" "}
						<Link href="/es/docs/email/">Email</Link>,{" "}
						<Link href="/es/docs/telegram/">Telegram</Link> y{" "}
						<Link href="/es/docs/webhooks/">webhooks</Link>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Herramientas</span>
					<h2>Dale Linear sin darle la clave</h2>
					<Screen>{`
> /mcp add linear https://mcp.linear.app/mcp
"linear" is on the shelf, and this agent has it.

Any other agent can have it too, with /mcp linear.
`}</Screen>
					<p>
						Una línea, y en su turno siguiente el agente tiene las herramientas de Linear
						registradas como suyas. Los servidores MCP van a un estante que guarda el plano, así que
						cada agente después del primero es un nombre de una lista.
					</p>
					<p>
						A un servidor que quiere una cuenta se entra desde la consola, y el token que vuelve se
						queda en el plano. Lo que el agente recibe es la herramienta; lo que nunca recibe es el
						secreto.
					</p>
					<p className="small muted">
						<Link href="/es/docs/mcp/">Servidores MCP</Link>, y{" "}
						<Link href="/es/docs/search/">búsqueda web</Link>, que es un endpoint concedido y la
						lectura hecha al otro lado.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Manejarlo</span>
					<h2>Una sola pantalla, y es una terminal</h2>
					<p>
						<code>squad</code> a secas abre la consola del principio de esta página: cada agente a
						la izquierda, la conversación a la derecha, <code>tab</code> para el feed de registro,{" "}
						<code>/</code> para los comandos y <code>!</code> para la shell de dentro de la caja.
					</p>
					<p>
						Una clave, un modelo, un buzón, un servidor MCP, un techo — todo se configura desde ahí
						dentro, y rige a partir del turno siguiente sin reiniciar nada.
					</p>
					<table className="table table-cmd">
						<tbody>
							{SLASH.map(([cmd, what]) => (
								<tr key={cmd}>
									<td>{cmd}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="small muted">
						Y es un programa en tu PATH, así que las partes de él que van en un script son un
						script. <Link href="/es/docs/console/">La consola</Link> tiene todas las teclas y todos
						los comandos.
					</p>
					<table className="table table-cmd">
						<tbody>
							{COMMANDS.map(([cmd, what]) => (
								<tr key={cmd}>
									<td>{cmd}</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Ver lo que pasó</span>
					<h2>Cada turno dice qué ejecutó, qué respondió y cuánto costó</h2>
					<p>
						Una petición que fue rechazada, o que volvió con 401, se dice en el momento en que pasa.
						Las cien que funcionaron se cuentan en vez de imprimirse.
					</p>
				</div>
				<div className="wrap-wide">
					<Feed rows={FEED} />
					<p className="caption">
						<code>squad logs</code> — lo que cada agente ejecuta, responde y gasta.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Los límites</span>
					<h2>Tres reglas que no puede sortear hablando</h2>
					{PROBLEMS.map((p) => (
						<div className="rule" key={p.rule}>
							<h3>{p.problem}</h3>
							<p>{p.body}</p>
							<p className="rule-out">{p.rule}</p>
						</div>
					))}
					<p className="small muted">
						La red del sandbox no tiene rutas, así que el proxy no es una comodidad que pudiera
						esquivar: hasta llegar al proveedor del modelo es una aprobación.{" "}
						<Link href="/es/docs/trust/">Confianza</Link> y{" "}
						<Link href="/es/docs/grants/">alcance</Link> son donde eso se detalla.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Lo que falta a propósito</span>
					<h2>La lista honesta</h2>
					<ul className="list">
						<li>
							<strong>Slack, Discord y los demás.</strong> El correo, Telegram y los webhooks están.
							Los otros son adaptadores que nadie ha escrito todavía.
						</li>
						<li>
							<strong>Nada multi-tenant.</strong> Un archivo de configuración, un operador, una
							máquina.
						</li>
						<li>
							<strong>Aislamiento más fuerte que un contenedor.</strong> Un contenedor Docker por
							agente, no una microVM — porque si autoalojarlo necesitara microVMs nadie lo
							ejecutaría.
						</li>
						<li>
							<strong>Nada alojado.</strong> No hay cuenta, ni panel, ni factura nuestra. Tú pones
							una máquina y una clave de modelo, y lo que cuesta es lo que cobre tu proveedor.
						</li>
					</ul>
					<div className="jump-row">
						<Link href="/es/install" className="jump">
							ponlo en un VPS →
						</Link>
						<Link href="/es/docs" className="jump">
							lee la documentación
						</Link>
						<a href={REPO} className="jump">
							lee el código
						</a>
					</div>
				</div>
			</section>
		</Layout>
	);
}
