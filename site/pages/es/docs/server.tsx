import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";
import { INSTALL } from "../../../lib/site";

const HOSTS: [string, string, string][] = [
	[
		"Hetzner",
		"https://www.hetzner.com/cloud",
		"más máquina por el dinero — unos €4,50 compran dos núcleos y 4 GB, en Europa y Estados Unidos",
	],
	[
		"Linode",
		"https://www.linode.com/pricing/",
		"$5 por un núcleo y 1 GB, en once regiones, y la pantalla de creación más sobria de las cuatro",
	],
	[
		"Vultr",
		"https://www.vultr.com/pricing/",
		"desde unos $5, y en más lugares que los otros tres juntos",
	],
	[
		"DigitalOcean",
		"https://www.digitalocean.com/pricing/droplets",
		"unos dólares más, y del que más se ha escrito — vale la pena si este es tu primer servidor",
	],
];

const FORM: [string, string][] = [
	[
		"región",
		"Dónde está físicamente la máquina. La latencia no importa acá — nadie teclea en esta cosa, y a un agente que despierta a las tres de la mañana no le importan cuarenta milisegundos. Elegí el país bajo cuya ley prefieras que estén tus datos, o el más cercano a vos, y seguí adelante.",
	],
	[
		"imagen",
		"El sistema operativo. Ubuntu LTS o Debian stable, y esta página asume uno de los dos. Sirve cualquiera con SSH y un gestor de paquetes; el instalador trae Docker por su cuenta, así que una imagen que ya diga Docker no te compra nada.",
	],
	[
		"tamaño",
		"El fondo de la lista. Una vCPU, un gigabyte de memoria y diez gigabytes de disco corren unos cuantos agentes — es la fila más barata de la página de cualquier proveedor, y en la que hay que hacer clic.",
	],
	[
		"autenticación",
		"Una clave SSH, o una contraseña de root. Es la única fila del formulario en la que vale la pena detenerse, y la siguiente sección va entera de eso.",
	],
	[
		"el resto",
		"Copias de seguridad, monitorización, red privada, una IP flotante, un firewall. Todo apagado. Ninguno hace falta para empezar y cada uno es una línea en la factura.",
	],
];

export default function Server() {
	return (
		<Docs
			title="Un servidor"
			lede="Los agentes son contenedores, y los contenedores necesitan una máquina que se quede encendida. La fila más barata de la lista de cualquier proveedor basta, y todos esos proveedores te hacen las mismas cinco preguntas con nombres distintos."
			description="Alquilá un VPS de cinco dólares en cualquier proveedor, entrá con una clave SSH o la contraseña de root, y poné el plano en él."
		>
			<section>
				<span className="eyebrow">Por qué hay una máquina siquiera</span>
				<h2>Algo tiene que estar despierto cuando vos no lo estás</h2>
				<p>
					Un agente que despierta a las nueve de un día laborable, o en el momento en que falla una
					compilación, es un agente en un equipo que no se durmió con la tapa. Ese es todo el
					argumento a favor de un servidor, y es por lo que el requisito es tan pequeño: esta es una
					máquina que está ociosa casi todo el tiempo y piensa a ráfagas, y el pensar ocurre en el
					proveedor de modelos al que le diste una clave, no acá.
				</p>
				<p>
					Así que el fondo de cualquier lista lo mueve.{" "}
					<strong>Una vCPU, un gigabyte de memoria, diez gigabytes de disco</strong>, cualquier
					Linux con SSH. El instalador trae Docker si la máquina no lo tiene. Un equipo viejo debajo
					del escritorio sirve igual, y también una máquina del trabajo a la que llegues — nada de
					lo que sigue es específico de alquilar.
				</p>
			</section>

			<section>
				<span className="eyebrow">Dónde comprar uno</span>
				<h2>Cuatro que son baratos, y la diferencia entre ellos no es squad</h2>
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
					Los precios se mueven, así que leelos como la forma y no como la cotización. Lo que no se
					mueve es la forma de la factura: la máquina es un número mensual fijo, y el único otro
					costo es aquello con lo que piensan los agentes — medido por el proveedor de modelos, y
					limitado por <Link href="/es/docs/limits/">limitUsd</Link> a cinco dólares al día por
					agente hasta que digas otra cosa. No hay nada que pagar por squad en sí.
				</p>
			</section>

			<section>
				<span className="eyebrow">La pantalla de creación</span>
				<h2>Cinco preguntas, con cuatro juegos de nombres puestos</h2>
				<p>
					El formulario de cada proveedor es el mismo formulario. Hetzner llama a la máquina Cloud
					Server, Linode la llama Linode, DigitalOcean la llama Droplet y Vultr la llama Instance, y
					debajo de las palabras te preguntan esto:
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
					Un minuto después de hacer clic en crear hay una dirección IP en la pantalla. Esa
					dirección, y una manera de entrar, es todo lo que squad necesita de este proveedor — no
					hay que configurarle nada acá, y no hay que abrir ningún puerto.
				</p>
			</section>

			<section>
				<span className="eyebrow">La fila en la que vale la pena detenerse</span>
				<h2>Una clave y una contraseña son ambas maneras de entrar, y una no es peor</h2>
				<p>
					Una clave es un archivo en tu equipo que el servidor reconoce. Una contraseña es una
					cadena que el proveedor te envía por correo o te muestra una vez. Las dos te dejan entrar,
					las dos son sobre lo que viaja squad, y la diferencia real es que una contraseña hay que
					volver a escribirla y una clave no.
				</p>
				<p>
					<strong>Si el formulario ofrece aceptar una clave</strong>, dale una. La tuya
					probablemente ya está ahí, y esto la imprime:
				</p>
				<Code>{`
$ cat ~/.ssh/id_ed25519.pub
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… you@your-laptop
`}</Code>
				<p>
					<code>No such file or directory</code> significa que este equipo nunca ha hablado SSH, lo
					cual no es raro y se arregla con un comando:
				</p>
				<Code>{`
$ ssh-keygen -t ed25519
`}</Code>
				<p className="small muted">
					Pulsá intro en todas sus preguntas. Escribe dos archivos — <code>id_ed25519</code>, que es
					el secreto y nunca sale de este equipo, y <code>id_ed25519.pub</code>, que es la línea que
					pegás en la casilla del proveedor. Una máquina más antigua puede tener{" "}
					<code>id_rsa.pub</code> en su lugar; también sirve.
				</p>
				<p>
					<strong>Si no lo hace, o preferís que no</strong>, tomá la contraseña de root. Un servidor
					comprado esta mañana con una contraseña en un correo es un punto de partida perfectamente
					bueno, y squad espera exactamente ese caso — la siguiente sección es lo que hace al
					respecto.
				</p>
			</section>

			<section>
				<span className="eyebrow">Y entonces squad pregunta</span>
				<h2>Una dirección, y el resto lo averigua probando</h2>
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
					El prompt ya dice <code>root@</code>, así que la dirección IP que el proveedor acaba de
					darte lo termina. Un nombre sirve igual que una dirección, y también un host de tu{" "}
					<code>~/.ssh/config</code> — cualquier cosa a la que <code>ssh</code> pueda llegar. Una
					línea vacía es la respuesta de quien todavía no ha comprado uno, e imprime la lista de
					arriba en lugar de un error.
				</p>
				<p>
					Lo que pasa a continuación es una conexión que prueba la clave y nada más. Si la máquina
					la acepta, esa conexión es sobre la que luego viajan la instalación y la consola, y nunca
					se te preguntó nada. Si rechaza la clave, hay exactamente dos cosas que hacer al respecto
					y se te pregunta cuál:
				</p>
				<Screen>{`
203.0.113.9 does not take this computer's key.

  1  Put one up         appends it to authorized_keys, and nothing asks again
  2  Keep the password  asked once per connection, and one lasts ten idle minutes

  1 or 2
`}</Screen>
				<p>
					<strong>Subir una</strong> gasta la contraseña una vez. Tu clave pública sube por la misma
					conexión que abre la contraseña, añadida a <code>authorized_keys</code> y sin tocar nada
					más, y después de eso nada pregunta — ni la instalación, ni la consola, ni un puerto
					reenviado desde un sandbox más tarde. Ejecutalo una segunda vez y una clave que ya esté en
					el archivo se queda donde está.
				</p>
				<p>
					<strong>Quedarse con la contraseña</strong> es una respuesta real y no el consuelo. Se
					pide una vez por conexión, y una conexión dura diez minutos de inactividad, así que se
					escribe más o menos tan a menudo como te alejás de la máquina — y nunca en medio de nada,
					porque la conexión siempre se abre primero, en una terminal desnuda, antes de que se
					dibuje la consola.
				</p>
				<div className="note">
					<p>
						<strong>La pregunta se hace como una preferencia, porque lo es.</strong> Una clave no
						aparece en tu servidor porque el programa la prefiriera, y una contraseña no se trata
						como la manera de entrar más débil. Cuando la conexión muere por otra cosa — un nombre
						que no resuelve, una clave de host que cambió — obtenés lo que dijo <code>ssh</code> y
						no un prompt de contraseña encima.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">Qué aterriza ahí</span>
				<h2>Un script, y nada de la consola se queda atrás</h2>
				<p>
					La consola envía un único script de shell por esa conexión. Instala Docker si no hay, pone
					el repositorio en <code>/opt/squad</code>, escribe una configuración con un agente y un
					techo de cinco dólares al día, arranca el plano y deja <code>squad</code> en el PATH de
					esa máquina. Luego te deja en la consola, acá, en tu propio equipo.
				</p>
				<p>
					Ese script se sostiene solo, y ejecutarlo en la terminal del propio servidor es la misma
					instalación con las preguntas que solo puede hacer cuando hay alguien para responder:
				</p>
				<Code label="en el servidor" wrap>{`
$ curl -fsSL ${INSTALL} | sh
`}</Code>
				<p className="small muted">
					Ejecutarlo otra vez es la actualización — hace pull, reconstruye y mete el plano en su
					sitio, y nunca toca <code>config.yaml</code> ni <code>.env</code>.{" "}
					<code>squad update</code> hace eso desde tu propio teclado, en la máquina en la que esté
					el plano.
				</p>
			</section>

			<section>
				<span className="eyebrow">Qué no abrir</span>
				<h2>No hay puerto, así que no hay firewall que escribir</h2>
				<p>
					La superficie de control es un socket unix en el directorio de estado y nunca sale de la
					máquina. Nada se publica, nada escucha por vos, y no hay cuenta que crear ni token que
					emitir: SSH ya decide quién puede tocar ese host, y tocar ese host es todo lo que
					significa tener ese socket. Así que el firewall del proveedor puede quedarse exactamente
					como lo dejó su valor por defecto.
				</p>
				<p>
					La única excepción es deliberada y vos la elegís.{" "}
					<Link href="/es/docs/webhooks/">Los webhooks</Link> publican el puerto <code>8787</code>,
					que solo acepta peticiones firmadas — y solo lo necesitás si algo en internet tiene que
					poder despertar a un agente. Telegram y el correo no necesitan nada publicado, porque
					salen ellos en vez de ser alcanzados.
				</p>
				<div className="note">
					<p>
						<strong>Por qué no hay una interfaz web en la que iniciar sesión.</strong> El plano de
						control tiene el socket de Docker, así que equivale a root en la máquina — la frontera
						de confianza es el sandbox alrededor del agente, no el proceso que lo gestiona. Publicar
						esa superficie de control sería poner root en internet detrás de una contraseña que
						eligió alguien. <Link href="/es/docs/trust/">Confianza</Link> tiene el resto de lo que
						eso afirma y no afirma.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">Si cambiás de idea</span>
				<h2>La respuesta se recuerda, y un comando la mueve</h2>
				<p>
					Dónde viven los agentes se pregunta una vez y se guarda en{" "}
					<code>~/.squad/plane.json</code>. <code>squad connect</code> vuelve a preguntar — así un
					plano que empezó en tu equipo se muda a un servidor que compraste después, y un servidor
					con el que ya terminaste se reemplaza por otro, sin reinstalar la consola.
				</p>
				<p className="small muted">
					Todo lo que viene después de esa pregunta es el mismo programa. Un plano responde al mismo
					protocolo tanto si su socket está en un directorio de este equipo como al otro extremo de
					una conexión SSH, y por eso <Link href="/es/docs/console/">la consola</Link>,{" "}
					<Link href="/es/docs/serve/">un puerto reenviado</Link> y el feed de logs se comportan
					igual en ambos casos.
				</p>
			</section>
		</Docs>
	);
}
