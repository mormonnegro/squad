import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

const CLI: [string, string][] = [
	["squad", "la consola: cada agente, sus turnos y sus logs en una sola pantalla"],
	["squad chat scout", "hablar con uno en el scrollback, turno tras turno"],
	["squad ls", "qué es cada agente y si está en marcha"],
	[
		'squad wake scout "check the issues"',
		"tomar un turno, como el operador, y esperar la respuesta",
	],
	["squad logs", "seguir lo que cada agente ejecuta, responde y gasta"],
	["squad rm scout [--purge]", "el sandbox, y con --purge el repositorio que hay dentro"],
	["squad connect", "volver a preguntar dónde deben vivir los agentes"],
	["squad update", "el último squad en el plano y en este equipo"],
	["squad help", "el resto"],
];

const KEYS: [string, string][] = [
	[
		"↑ ↓",
		"recorrer la columna: cada agente, la fila que crea uno, el feed, la pantalla de configuración",
	],
	["tab", "el mismo anillo, y shift-tab para la vuelta"],
	["← →", "las líneas que has escrito a este agente, izquierda para las más antiguas"],
	["^U ^D", "medio panel, como se mueve less"],
	["/", "los comandos, filtrados por lo que se escriba después"],
	["!", "la shell dentro del sandbox, desde un prompt vacío"],
	["esc", "detener el turno que está tomando este agente"],
	["^C", "salir, y el terminal vuelve como estaba"],
];

const SLASH: [string, string, string][] = [
	["/limit", "[<amount>|off]", "lo que ha gastado hoy, y el techo para ello"],
	["/model", "[<name>]", "con qué piensa, y qué más hay"],
	["/mcp", "[<name>|add …|login …]", "los servidores MCP que tiene, y el estante del que añadir"],
	[
		"/serve",
		"[<port>|stop <port>]",
		"abrir un puerto suyo en la máquina ante la que estás sentado",
	],
	["/telegram", "[<token>|off]", "el bot en el que responde, y cómo emparejar uno"],
	[
		"/email",
		"[<address>|<password>|off]",
		"la dirección en la que se le alcanza, y cómo conectar un buzón",
	],
	["/clear", "", "olvidar la conversación, y empezarla de nuevo sobre nada"],
	["/delete", "", "borrar este agente, después de preguntar si era eso lo que querías"],
	[
		"/config",
		"[models|search|grants|mcp|email]",
		"la pantalla del plano entero: sus claves, modelos, alcance y buzón",
	],
	["/help", "", "todos los comandos que hay"],
];

export default function Console() {
	return (
		<Docs
			title="La consola"
			lede="Un plano en marcha escucha en un socket unix dentro de su directorio de estado. Esa es toda la superficie de control, y estos se escriben en tu propio equipo esté el plano en la máquina que esté."
			description="La consola de squad: los comandos, la pantalla, cada tecla, los comandos de barra y la shell hacia el sandbox."
		>
			<section>
				<span className="eyebrow">En una shell</span>
				<h2>Nueve comandos, y el primero es la cosa misma</h2>
				<table className="table table-cmd">
					<tbody>
						{CLI.map(([cmd, what]) => (
							<tr key={cmd}>
								<td>{cmd}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					El nombre solo hace falta cuando hay una elección que hacer: un plano que corre un solo
					agente ya sabe a cuál se refiere, así que <code>squad wake "check the issues"</code>{" "}
					funciona, y una primera palabra que nombra a un agente se dirige a él. Un nombre al que no
					responde ningún agente se rechaza antes de encolar nada — el plano aceptaría si no el
					evento y lo entregaría a nadie, y esa espera dura quince minutos y se parece exactamente a
					un agente pensando.
				</p>
				<p className="small muted">
					La consola necesita un terminal del que pueda apoderarse y un plano sobre el que abrirse.
					Si falta cualquiera de los dos — una tubería, un job de CI, ningún plano en marcha —{" "}
					<code>squad</code> imprime dónde está el estado y qué hay en él, así que{" "}
					<code>squad | grep</code> sigue funcionando y nada tiene que saber en qué caso está.
				</p>
			</section>

			<section>
				<span className="eyebrow">La pantalla</span>
				<h2>Una columna, de arriba abajo</h2>
				<Screen>{`
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ demo                         deepseek-v4-flash   $0.42 / $5.00 │
│                      ││                                                                │
│ ◐ demo         $0.42 ││ > what is a webhook                                            │
│ ● maxi     15m $4.80 ││                                                                │
│ ○ scout              ││ A webhook is one service telling another that something        │
│                      ││ happened: when an event fires, the first sends an HTTP         │
│ + new agent          ││ request to a URL you configured.                               │
│                      ││ ⠹ 9s search webhook retry semantics                            │
│ logs                 ││ ⋯ and how often does it retry?                                 │
│ config               ││                                                                │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│                      ││ │ >                                                          │ │
│ ↑↓ moves             ││ ╰────────────────────────────────────────────────────────────╯ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ agents   ←→ history   ^U^D scroll   / commands   ! shell   ^C quit
`}</Screen>
				<p>
					La columna de la izquierda es todo lo que esta consola puede mostrar, como una sola lista:
					cada agente que tiene el plano — <code>●</code> en marcha, <code>○</code> parado,{" "}
					<code>◐</code> a mitad de turno — luego la fila que crea uno, luego el feed de logs y la
					pantalla de configuración. Pensar recibe una marca propia porque con varios agentes en
					pantalla es lo único que no podés averiguar volviendo a preguntar dentro de un segundo.
				</p>
				<p>
					El feed y la pantalla de configuración están al pie de la columna y no detrás de un agente
					porque ninguno de los dos trata de un agente. El feed es del plano, un solo flujo con
					todos los agentes dentro, y la pantalla de configuración es todo lo que se le dio al plano
					mismo. Debajo de los agentes y no encima porque ese es el orden en que se usan: esto se
					abre para hablar con un agente, y al feed se va cuando algo va mal, o a las claves una
					vez, al principio.
				</p>
				<p>
					Lo que cada agente ha gastado hoy está en su fila, porque "cuál de estos se está quemando
					el día" es una pregunta sobre todos a la vez y la cabecera solo puede responderla sobre
					aquel en el que estás parado. Se pone amarillo a cuatro quintos de su techo y rojo al
					llegar, y un agente que no ha gastado nada no dice nada. Donde un nombre deja sitio para
					solo uno de los dos gana la espera — <code>15m</code> arriba es un agente que actuará
					mientras nadie mira, y el dinero no es eso.
				</p>
				<p className="small muted">
					Un turno no se espera, así que preguntar algo a un agente y ponerse luego a ver pensar a
					otro es cuestión de pulsar <code>↑</code>. Cada agente guarda su propia conversación y
					esta pertenece al plano y no a la consola, así que cerrar una no es terminarla: la
					siguiente consola abre sobre lo que se dijo.
				</p>
			</section>

			<section>
				<span className="eyebrow">Las teclas</span>
				<h2>Dos para la lista, dos para el historial</h2>
				<table className="table">
					<tbody>
						{KEYS.map(([key, what]) => (
							<tr key={key}>
								<td>{key}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					La línea ya enviada se recorre hacia atrás de lado porque este prompt no admite cursor:
					nunca hubo una línea que recorrer con izquierda y derecha, así que no le cuestan nada, y
					arriba y abajo van a la columna, que es lo único de esta pantalla que es una lista. La
					línea a medio escribir en la que estabas cuando empezó el recorrido vuelve entera al final
					de él.
				</p>
				<p className="small muted">
					<code>esc</code> se ofrece en la fila de pistas solo mientras hay un turno que detener,
					porque una pista de una tecla que no hace nada es una pista que miente. Lo que se detiene
					es el proceso dentro del contenedor, matado y no desconectado — soltar la tubería deja un
					modelo pensando al otro lado de ella, cobrándose todavía después de que a alguien se le
					haya dicho que paró. La pregunta que lo inició vuelve al prompt, solo sobre un prompt
					vacío y solo mientras no haya vuelto nada.
				</p>
				<p className="small muted">
					Arrastrar por encima de la conversación resalta las filas y soltar el botón las pone en el
					portapapeles, <code>⧉ 3 rows copied</code> en la fila de pestañas para decir que llegó.
					Por <code>ssh</code> no hay programa local al que entregar el texto, así que va al
					terminal como una secuencia OSC 52 y la fila dice <code>sent to the terminal</code> en
					lugar de reclamar un portapapeles que no puede ver. La consola toma la ventana entera y la
					devuelve al salir, como hacen <code>less</code> y <code>vim</code>.
				</p>
			</section>

			<section>
				<span className="eyebrow">Dicho al plano, no al agente</span>
				<h2>Una línea que empieza por barra</h2>
				<p>
					Es un comando sobre el agente y no algo dicho a él, respondido por el plano sin despertar
					nada — un turno gastado en leer un cambio de ajustes es un turno perdido. La barra abre la
					lista de lo que hay, sobre el prompt, filtrada por lo que se escriba después.
				</p>
				<table className="table table-cmd">
					<tbody>
						{SLASH.map(([cmd, takes, what]) => (
							<tr key={cmd}>
								<td>
									{cmd}
									{takes === "" ? "" : ` ${takes}`}
								</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					<code>↑↓</code> mueven entre las entradas y <code>⏎</code> o <code>tab</code> toma una. Un
					primer retorno elige y un segundo envía, porque a todo comando de acá se le puede dar un
					argumento y un retorno que disparara en cuanto se resaltara un nombre haría de{" "}
					<code>/limit 5</code> lo único que el menú no serviría para escribir. Donde el argumento
					es a su vez un nombre sacado de una lista — <code>/model</code>, y los modelos — el
					espacio detrás del comando abre también esa lista.
				</p>
				<p className="small muted">
					Un mensaje que simplemente empieza por una ruta sigue siendo un mensaje:{" "}
					<code>/etc/hosts is wrong</code> vuelve como un comando que no existe en lugar de ser
					tragado en silencio. Y <code>/config</code> es la única fila que no trata del agente en
					cuyo prompt se escribió — mueve la columna a{" "}
					<Link href="/es/docs/config/">la pantalla del plano mismo</Link>, y nombrar una sección
					aterriza dentro de ella.
				</p>
			</section>

			<section>
				<span className="eyebrow">Mirar por dentro</span>
				<h2>! es la puerta a la caja</h2>
				<Screen>{`
! ~/.self  git status --short
 M src/queue.ts
! ~/.self  cd packages/queue
/home/agent/.self/packages/queue
! ~/.self/packages/queue  curl -s api.github.com
curl: (56) Received HTTP code 403 from proxy after CONNECT
exit 56
`}</Screen>
				<p>
					Pulsar <code>!</code> en un prompt vacío te mete dentro, y el prompt dice dónde estás
					parado. Seguís dentro hasta que borrás hacia atrás desde la línea vacía, porque nadie mira
					una máquina de un comando en un comando, y <code>cd</code> te mueve como lo hace en
					cualquier otro sitio — cada comando es su propio <code>sh</code>, así que el plano lleva
					el directorio de uno al siguiente.
				</p>
				<p>
					Corre donde corre el agente, como el agente — el mismo directorio, el mismo entorno, el
					mismo proxy — así que lo que vuelve trata del mundo del agente y no de una shell que
					casualmente está al lado, y <code>!curl</code> se rechaza exactamente donde se rechazaría
					el del agente. No concede nada: quien puede alcanzar el socket de control ya tiene el
					socket de Docker sobre el que corre el plano y podría abrir la misma shell dando el rodeo.
				</p>
				<p className="small muted">
					<code>tab</code> completa una ruta acá, que es lo que <code>tab</code> es en un prompt de
					shell en todas las demás partes — así que en este modo deja de cambiar de panel, y el
					camino a los otros paneles pasa por una línea vacía. Nada del completado se registra y
					nada de él se ejecuta: se le pide al sandbox que lea un directorio con la palabra a medio
					escribir entregada como argumento, así que un directorio al que el agente llamó{" "}
					<code>; rm -rf ~</code> sigue siendo un directorio.
				</p>
				<p className="small muted">
					Es independiente del turno, así que a un agente que está pensando se le puede mirar
					mientras piensa, que es cuando más hay que ver — y al agente no se le dice que ocurrió,
					porque mirar por dentro no es lo mismo que decir algo.
				</p>
			</section>

			<section>
				<span className="eyebrow">De dónde vino un turno</span>
				<h2>Todo lo que no se escribe acá lleva una marca</h2>
				<Screen>{`
> how is the queue looking?
four issues open, none of them blocked.
‹wake› check the queue again
still the same.
‹email› and the build?
‹→ email› green since last night.
‹webhook:github› the nightly build failed on main
`}</Screen>
				<p>
					Un turno que nadie inició ante un teclado aparece también en la conversación — un horario
					que vence, un webhook que llega, un mensaje que enviaste por correo, un agente que se
					despierta a sí mismo — con una marca que dice de dónde vino. Tu propio correo va marcado
					también, y por la misma razón: sos vos, y no sos vos en este teclado. Un agente que
					respondió a su correo a las cuatro de la mañana se leería si no, horas después, como algo
					que te habías sentado a escribir.
				</p>
				<p>
					La respuesta a él lleva una flecha, porque es la mitad que se fue a algún sitio. Una
					respuesta escrita en el panel y una respuesta que además se envió son las mismas palabras,
					y sin la marca el panel es la misma imagen en cualquiera de los dos casos. Lo que
					escribiste acá se responde acá, y eso se deja sin marcar — marcarlo marcaría casi todas
					las líneas que un agente llega a decir.
				</p>
				<p className="small muted">
					Solo lo que llega por el socket de control se dibuja como el operador. Todo lo demás se
					nombra por el canal por el que entró, porque el panel se relee para averiguar quién pidió
					qué, y una línea de un desconocido dibujada igual que la del operador es el único bug de
					una ventana de chat que importa. <Link href="/es/docs/trust/">La confianza</Link> es esa
					regla entera.
				</p>
			</section>

			<section>
				<span className="eyebrow">El feed</span>
				<h2>Lo que cada agente ejecuta, responde y gasta</h2>
				<Screen>{`
18:12:53  maxi      bash        pnpm -r test
18:12:53  maxi      bash      ✗ after 12.4s: FAIL test/turn.test.ts > carries the failure detail
18:12:53  maxi      read        packages/control-plane/src/turn.ts
18:12:53  scout     egress    ✗ denied GET api.github.com/repos — no_matching_host
18:12:53  maxi      answer      The test asserted the old message.
18:12:53  maxi      spent       1m38s · 91.2k tokens · $0.02 · api.deepseek.com ×12
`}</Screen>
				<p>
					Los comandos que cada agente ejecuta dentro de su sandbox según los ejecuta, lo que
					imprimió uno que falló y cuánto tardó en fallar, la respuesta cuando el turno acaba, y lo
					que gastó el turno. Las idas y vueltas al modelo que funcionaron se cuentan en lugar de
					imprimirse, y la cuenta llega con el turno que las hizo — un{" "}
					<code>allowed POST api.deepseek.com</code> idéntico por petición es aquello en lo que
					solían quedar enterradas las líneas que importan.
				</p>
				<p className="small muted">
					Una petición que fue denegada, o volvió con 401 o 429, se dice en el momento en que
					ocurre, porque es la razón por la que el agente está a punto de portarse mal.
				</p>
			</section>

			<section>
				<span className="eyebrow">Pedido en lugar de escrito</span>
				<h2>Un agente puede pedir algunos de estos</h2>
				<Screen>{`
‹ask› /mcp add ahrefs https://mcp.ahrefs.com/mcp
"ahrefs" is on the shelf, and this agent has it.

It wants an account first: /mcp login ahrefs

‹ask› /mcp login ahrefs
Log in to mcp.ahrefs.com here — opened already, if this console is somewhere with a browser:

  https://auth.ahrefs.com/authorize?response_type=code&client_id=…
`}</Screen>
				<p>
					Un agente que quería un servidor MCP escribía antes, con paciencia y corrección, el host
					que añadir y el comando que lo aprueba — y luego se quedaba ahí hasta que alguien leyera
					el párrafo. <code>console_command</code> pide en cambio comandos de consola por su nombre,
					y la respuesta va a la consola y no de vuelta al agente, porque la consola corre en la
					máquina en la que está la persona y el enlace termina en su navegador.
				</p>
				<p>
					Lo que puede pedir se decide fuera del comando, y la línea no es "destructivo" — es si un
					agente convencido de esto por algo que leyó podría llegar a alguna parte con ello.
					Conectar un servidor, abrir una pantalla de consentimiento, moverse entre modelos
					configurados, publicar un puerto y quedar sujeto a un techo <em>más estricto</em> no
					ensanchan nada. Borrarse a sí mismo, subir su techo, cerrar la sesión de un servidor,
					limpiar su propia conversación y abrir <code>/config</code> se quedan con el operador.
				</p>
				<Screen>{`
‹ask› /limit 50
This agent asked for a ceiling of $50.00 a day, which is above the $5.00 it has. It can ask to
be held to less, never to more: /limit $50.00, if you meant it.
`}</Screen>
				<p className="small muted">
					Un rechazo imprime la línea que el operador habría escrito, que es el objetivo y no el
					consuelo: el operador se entera de que el comando existe porque se lo entregan, en el
					momento en que es la respuesta. Con dos excepciones — <code>/telegram</code> y{" "}
					<code>/email</code> se rechazan sin la línea, porque ahí la línea <em>es</em> el ataque.
				</p>
			</section>
		</Docs>
	);
}
