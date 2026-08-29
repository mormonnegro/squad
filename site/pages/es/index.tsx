import Link from "next/link";
import type { ReactNode } from "react";
import { Code } from "../../components/Code";
import { Console } from "../../components/Console";
import { Feed, type FeedRow } from "../../components/Feed";
import { Layout } from "../../components/Layout";
import { Screen } from "../../components/Screen";
import { CLIENT, REPO } from "../../lib/site";

// The Spanish of TAGLINE in lib/site.ts. The hero reads this and so does the meta description, because
// a page that describes itself one way to a reader and another way to a search result is describing
// two different projects.
const TAGLINE =
	"Agentes en la nube que siguen trabajando mientras duermes. Dale a uno un trabajo permanente — vigilar un repositorio, seguir a un rival, arreglar un check que se rompió — y se despierta solo para hacerlo, y luego te escribe para contarte cómo fue.";

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
		who: "market",
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

// What somebody actually hands one, in the words they would use for it. Every line is a standing job
// rather than a demo: the question this page answers first is what a person would keep one for.
const JOBS: [string, ReactNode][] = [
	[
		"vigilar un repositorio",
		<>
			Un check se pone en rojo en un pull request. Lee el fallo, lo arregla, hace push a la rama y
			cuenta lo que hizo en el pull request — mientras tú almorzabas.
		</>,
	],
	[
		"seguir a un rival",
		<>
			Cada lunes a las ocho, tres páginas de precios y tres changelogs contra lo que anotó la semana
			pasada. Recibes un correo, y son las dos líneas que se movieron.
		</>,
	],
	[
		"un encargo largo",
		<>
			<em>Despliega cuando CI se ponga en verde</em> no es un turno. Comprueba, se reserva otro
			turno, vuelve a comprobar, y te escribe cuando está en producción — una hora después, o
			mañana.
		</>,
	],
	[
		"montar guardia",
		<>
			Una URL cada diez minutos, una cola que no debería crecer, un certificado que caduca. El
			mensaje llega desde una máquina que no es la que se cayó.
		</>,
	],
	[
		"un mostrador donde preguntar",
		<>
			Escríbele un correo, o mensajea a su bot desde una cola en el aeropuerto. Tiene el
			repositorio, las herramientas y cuatro meses de lo que le contaste, y responde en el hilo en
			el que preguntaste.
		</>,
	],
];

const SELF: [string, string][] = [
	["soul.md", "quién es; se añade al prompt de sistema en cada turno"],
	["memory/", "lo que eligió recordar, repartido por usuarios, proyectos y referencia"],
	["skills/", "cómo hacer las cosas que haces aquí, escrito una sola vez"],
	["tools/", "scripts que se escribió a sí mismo, y usa en vez de volver a resolverlo"],
	["agent.yaml", "las capacidades que le pide a un operador"],
];

const CHANNELS: [string, ReactNode][] = [
	[
		"email",
		<>
			Un buzón para todo el plano, conectado una vez con <code>/email</code>. Cada agente tiene su
			propia dirección dentro — <code>agents+scout@…</code> — y responde en el hilo. Sin dominio,
			sin registro DNS, sin puerto que abrir.
		</>,
	],
	[
		"telegram",
		<>
			Un bot por agente: dos mensajes a BotFather, el token en <code>/telegram</code>, y tu teléfono
			es donde se escriben los encargos de una línea. Emparejado contigo por una frase, así que es
			de ti de quien acepta instrucciones.
		</>,
	],
	[
		"webhook",
		<>
			Para sistemas y no para personas. GitHub, un despliegue, cualquier cosa que pueda firmar una
			petición — y lo que un desconocido escribió en el cuerpo del issue llega citado, nunca como
			algo que hacer.
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
				cualquiera. Así que todo lo que no vino de ti llega delimitado, como datos — en un solo
				sitio, para que un canal nuevo no pueda olvidarse de hacerlo.
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
				Es dueño de su repositorio, y una línea dentro es una petición. Lo que un agente puede
				alcanzar se responde en un archivo que no puede escribir, así que puede pedir una capacidad
				y no llegar a ninguna parte pidiéndola.
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
						<p className="small">
							Hace una sola pregunta: dónde deben vivir los agentes. <strong>En este equipo</strong>
							, o <strong>en un servidor</strong> al que tengas SSH — se instala allí por la
							conexión que ya tienes. La consola en la que escribes se queda aquí en cualquier caso.
						</p>
						<p className="small muted">
							Node 22.18 o más nuevo, y nada más. <Link href="/es/install">Lo que hace</Link>, y si
							aún no tienes servidor, <Link href="/es/install#a-machine">uno cuesta $5 al mes</Link>
							.
						</p>
					</div>
					<div className="hero-meta">
						<span>Una máquina para cada uno</span>
						<span>Se despierta solo</span>
						<span>Te escribe correos y mensajes</span>
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
						Un agente por trabajo, que es lo que es la columna de la izquierda de esa consola:
						cinco, cada uno con su propia máquina, su propia memoria del trabajo y su propio techo
						para el día. Hacer el siguiente es un nombre y <code>⏎</code>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Dónde trabaja</span>
					<h2>Su propia máquina, y root en ella</h2>
					<p>
						Cada agente recibe una caja propia — su propio sistema de archivos, sus propios
						procesos, sus propios paquetes instalados. Puede bajarse un toolchain a las tres de la
						mañana, ejecutar tu suite de tests cuarenta veces, llenar el disco con una compilación
						mala y volver a vaciarlo. Tu equipo no está en el radio de la explosión, y el agente de
						al lado tampoco.
					</p>
					<p>
						Eso es lo que hace que valga la pena darle trabajo de verdad. No describe el arreglo,
						hace el arreglo y ejecuta los tests; no sugiere un script, escribe el script, descubre
						que el flag estaba mal, y lo arregla antes de decirte nada.
					</p>
					<p>
						Dos cosas sobreviven al contenedor. <code>~/workspace</code> es el escritorio donde
						guarda tus proyectos, y <code>~/.self</code> es el agente mismo — un repositorio git del
						que es dueño:
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
						veces desde la shell a algo incómodo se escribe un script para la cuarta, hace commit, y
						el viernes es mejor en tu trabajo de lo que era el lunes. Ese repositorio se monta una
						vez y luego se deja en paz: lo que aprende y lo que sabe hacer son archivos que edita él
						mismo, y aquí nada los sobrescribe.
					</p>
					<p className="small muted">
						<code>!</code> abre una shell en esa misma caja — mismo directorio, mismo entorno, mismo
						alcance — porque la manera de averiguar qué está mirando un agente es ponerse donde él
						está. Y <code>/serve 3000</code> saca un puerto de ahí a la máquina en la que está tu
						navegador, así que lo que construyó es un enlace en el que haces clic.{" "}
						<Link href="/es/docs/agents/">Agentes</Link> es la versión larga.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Mientras duermes</span>
					<h2>Se reserva su propio turno siguiente, y el día tiene un techo</h2>
					<p>
						Dos relojes. Uno que escribiste tú — cron, en una zona horaria que nombras, para que las
						nueve de la mañana sean las nueve de la mañana a ambos lados de un cambio de hora. Uno
						que se pone él mismo: <code>wake_me</code> pide otro turno dentro de tres minutos o tres
						días y deja una nota para la versión de sí mismo que se despierte.
					</p>
					<p>
						Ese segundo es la razón de que un trabajo largo sea algo que puedes delegar en vez de
						algo que hay que aguantar sentado. El trabajo que no cabía en una sentada terminaba
						cuando terminaba el turno. Ahora comprueba, espera, vuelve a comprobar, y lo que oyes es
						la respuesta.
					</p>
					<p>
						Y como un agente que se despierta solo es un agente que corre sin nadie mirando, cada
						uno de ellos tiene un techo en dólares al día:
					</p>
					<Screen>{`
> /limit 5
Spending limit set to $5.00 a day. $0.42 spent today, of $5.00 a day.
`}</Screen>
					<p>
						Alcanzarlo detiene el turno siguiente y no el que está en curso, y lo que llegue
						mientras tanto queda anotado y se responde cuando cambia el día. Un agente puede pedir
						que se le limite a menos; no llega a ninguna parte pidiendo más. Lo que cada uno lleva
						gastado hoy está en su fila de la columna, amarillo a cuatro quintos y rojo al llegar —
						antes de que sea una pregunta que a alguien se le ocurra hacer.
					</p>
					<p className="small muted">
						Con qué piensa es un comando y no un redespliegue, así que el trabajo permanente que
						corre cada mañana puede ir sobre algo barato y el trabajo que estás mirando sobre algo
						bueno. La clave es tuya y la factura es de tu proveedor — aquí no hay cuenta que
						sostenga ninguna de las dos. <Link href="/es/docs/schedules/">Horarios</Link>,{" "}
						<Link href="/es/docs/limits/">gasto</Link> y{" "}
						<Link href="/es/docs/models/">modelos</Link>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Estar localizable</span>
					<h2>Tiene una dirección y un teléfono</h2>
					<p>
						Un agente que solo existe dentro de una terminal es un agente que tienes que acordarte
						de ir a abrir. Estas son las maneras en que te llega él a ti, y en que llegas tú a él
						desde la cola del aeropuerto.
					</p>
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
						Una respuesta vuelve por donde entró la petición, así que a un agente que responde a un
						hook de GitHub no se le puede convencer con algo del payload de que responda en otra
						parte. Telegram y el correo se pueden emparejar con una persona — y lo que esa persona
						escribe es una instrucción. A todos los demás se les oye, se les cita y no se les
						obedece.
					</p>
					<p className="small muted">
						Ninguno de los dos cuesta un dominio, un certificado ni un puerto abierto: los dos
						llaman ellos en vez de ser llamados. <Link href="/es/docs/email/">Email</Link>,{" "}
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
						encontrar uno ocurre una vez y cada agente después del primero es un nombre de una
						lista. Cualquier cosa con servidor es un encargo que puedes delegar: el tracker, el
						reportador de errores, la base de datos, el navegador.
					</p>
					<p>
						A un servidor que quiere una cuenta se entra desde la consola, porque es ahí donde está
						el navegador. La pantalla de consentimiento se abre en tu máquina, y el token que vuelve
						se queda en el plano. Lo que el agente recibe es la herramienta; lo que nunca recibe es
						el secreto — la misma regla que la clave del modelo y que cualquier otra credencial de
						aquí.
					</p>
					<p className="small muted">
						No se despertó nada para responder a ese comando y no se gastó nada — una línea que
						empieza por <code>/</code> es sobre el agente y no algo que se le dice.{" "}
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
						<code>squad</code> a secas abre la consola, porque quien escribe el comando sin nada
						detrás está pidiendo ver la cosa, no que le cuenten un dato sobre ella. Es la del
						principio de esta página: cada agente a la izquierda, la conversación a la derecha,{" "}
						<code>tab</code> para el feed de registro, <code>/</code> para los comandos y{" "}
						<code>!</code> para la shell de dentro de la caja.
					</p>
					<p>
						Todo lo que un plano sabe se configura desde ahí dentro — una clave, un modelo, un
						buzón, un servidor MCP, un techo — y rige a partir del turno siguiente sin reiniciar
						nada. No hay ningún archivo que edites y redespliegues para cambiar con qué se le
						permite pensar a un agente.
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
						Una petición que fue rechazada, o que volvió con 401 o 429, se dice en el momento en que
						pasa, porque es la razón de que el agente esté a punto de portarse mal. Las cien que
						funcionaron se cuentan en vez de imprimirse, para que el feed sea algo que una persona
						pueda leer de verdad.
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
						esquivar: llegar al proveedor del modelo es una aprobación como cualquier otra, escrita
						sobre la petición al salir. <Link href="/es/docs/trust/">Confianza</Link> y{" "}
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
							máquina. Es tu caja y todos los agentes que hay en ella son tuyos.
						</li>
						<li>
							<strong>Aislamiento más fuerte que un contenedor.</strong> Un contenedor Docker por
							agente, no una microVM — porque si autoalojarlo necesitara microVMs nadie lo
							ejecutaría. No es una frontera dentro de la que meter código hostil.
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
