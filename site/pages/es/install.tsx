import Link from "next/link";
import { Code } from "../../components/Code";
import { Layout } from "../../components/Layout";
import { CLIENT, INSTALL, REPO } from "../../lib/site";

const ASKS: [string, string][] = [
	["Docker", "instalado desde get.docker.com si la máquina no tiene ninguno"],
	[
		"una clave de DeepSeek",
		"aquello con lo que piensan los agentes — se puede omitir, y los turnos fallan hasta que añadas una",
	],
	[
		"una clave de OpenAI",
		"cómo busca un agente en la web — opcional, la herramienta lo dice si no la hay",
	],
	[
		"una clave de Anthropic",
		"el otro modelo con el que arranca la configuración — opcional del mismo modo",
	],
];

const MACHINES: [string, string, string][] = [
	[
		"Hetzner",
		"https://www.hetzner.com/cloud",
		"más máquina por el dinero — unos 4,50 € compran dos núcleos y 4 GB, si te sirve una región europea o de EE. UU.",
	],
	[
		"Vultr",
		"https://www.vultr.com/pricing/",
		"desde unos $5, y en más sitios que los otros dos juntos",
	],
	[
		"DigitalOcean",
		"https://www.digitalocean.com/pricing/droplets",
		"unos dólares más, y sobre el que más se ha escrito — vale la pena si es tu primer servidor",
	],
];

export default function Install() {
	return (
		<Layout
			title="instalar"
			description="Instala la consola en el equipo ante el que estás sentado. Pregunta dónde deben vivir los agentes — aquí, o en un servidor al que tengas SSH — y pone un plano allí."
		>
			<section className="hero">
				<div className="wrap">
					<h1>Instalar</h1>
					<p className="lede">
						Dos mitades: la consola en la que escribes, y el plano en el que viven los agentes.
						Instalas la consola, y hace la única pregunta en la que las mitades difieren.
					</p>
					<div className="hero-meta">
						<span>Una pregunta</span>
						<span>~1 GB de RAM</span>
						<span>Sin base de datos, sin cuenta</span>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Desde tu equipo</span>
					<h2>Un comando, y pregunta una cosa</h2>
					<Code label="en tu equipo" wrap>{`
$ curl -fsSL ${CLIENT} | sh
$ squad
`}</Code>
					<p className="small muted">
						Necesita Node 22.18 o más nuevo y nada más — aquí no hay Docker, sea cual sea la
						respuesta que des. <a href={`${REPO}/blob/main/deploy/client.sh`}>deploy/client.sh</a>{" "}
						trae el árbol, instala lo que la consola importa, y deja <code>squad</code> en tu PATH.
						No hay paso de compilación, así que lo que aterriza es lo que se ejecuta, y volver a
						ejecutarlo es como se actualiza la consola.
					</p>
					<p>
						Lo que pregunta es dónde deben vivir tus agentes: <strong>en este equipo</strong>, lo
						que significa Docker y un directorio de estado bajo <code>~/.squad</code>, o{" "}
						<strong>en un servidor</strong> al que tengas SSH, lo que significa la instalación
						corriendo por la conexión que ya tienes. En cualquiera de los dos casos aterriza allí lo
						mismo — Docker si no hay, el repositorio, una configuración con un agente y un techo de
						cinco dólares al día, y el plano arrancado — y en cualquiera de los dos termina en la
						consola. La respuesta se recuerda, y <code>squad connect</code> la mueve.
					</p>
					<p>
						Todo lo que viene después de esa pregunta es el mismo programa. Un plano responde al
						mismo protocolo esté su socket en un directorio de aquí o al otro extremo de{" "}
						<code>ssh vps squad relay</code>, así que la lista de agentes, el feed de logs, la
						consola y un puerto reenviado fuera de un sandbox corren todos en este equipo y alcanzan
						a los agentes estén donde estén. Por eso también un puerto que expones desde un agente
						se abre en la máquina donde está tu navegador, que es el único sitio donde sirve de
						algo.
					</p>
					<p className="small muted">
						No pide ninguna clave. Todas se dan después en la pantalla de configuración de{" "}
						<code>squad</code>, porque tres secretos en el primer minuto son un primer minuto peor
						que una pantalla de configuración vacía en el segundo. Ejecuta la instalación otra vez
						cuando quieras y se convierte en la actualización: hace pull, reconstruye, sustituye el
						plano, y deja <code>config.yaml</code> y <code>.env</code> en paz — la segunda ejecución
						es la que desharía en silencio una concesión que alguien añadió.
					</p>
					<div className="note">
						<p>
							<strong>Nada de la consola se queda en el servidor.</strong> Canaliza un solo script
							de shell — <a href={`${REPO}/blob/main/deploy/install.sh`}>deploy/install.sh</a> — por
							la conexión SSH, y ese script se sostiene solo: está abajo, y es el mismo que corre
							cuando eliges este equipo. <a href="#by-hand">La misma instalación a mano</a> está al
							pie de esta página.
						</p>
					</div>
				</div>
			</section>

			<section id="a-machine">
				<div className="wrap">
					<span className="eyebrow">Si aún no tienes una</span>
					<h2>La máquina cuesta cinco dólares al mes</h2>
					<p>
						Una vCPU, un gigabyte de memoria y diez gigabytes de disco bastan para unos cuantos
						agentes, y eso es lo más bajo de la lista de cualquier proveedor. Necesita un Linux con
						SSH encima y nada más — el instalador trae Docker. Cualquiera de estas sirve, y también
						un equipo viejo debajo del escritorio o una máquina del trabajo a la que puedas llegar.
					</p>
					<table className="table">
						<tbody>
							{MACHINES.map(([who, href, what]) => (
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
						Los precios se mueven, así que tómalos como la forma y no como la cifra. Lo que no se
						mueve es la forma de la factura: la máquina es un número mensual fijo, y el único otro
						costo es aquello con lo que piensan los agentes, que mide el proveedor de modelos al que
						le des una clave y que <code>limitUsd</code> limita a cinco dólares al día por agente
						hasta que digas otra cosa. No hay nada que pagar por squad en sí.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">O la otra mitad, tú mismo</span>
					<h2>Lo que corre en la máquina que les toca a los agentes</h2>
					<p>
						Ejecutado en una terminal en vez de por una tubería, el instalador pide las claves sobre
						la marcha. Esa es toda la diferencia — el mismo script, y las preguntas existen solo
						porque ahora hay alguien ahí para responderlas.
					</p>
					<Code label="en tu VPS" wrap>{`
$ curl -fsSL ${INSTALL} | sh
`}</Code>
					<table className="table">
						<tbody>
							{ASKS.map(([what, why]) => (
								<tr key={what}>
									<td>{what}</td>
									<td>{why}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="small muted">
						Se leen de la terminal, no de la tubería, y aterrizan en un archivo <code>0600</code> al
						que los agentes no llegan. Todas se pueden omitir y dar después en la pantalla de
						configuración. No se pregunta nada más.
					</p>
					<p className="small muted">
						Deja <code>squad</code> también en el PATH de esa máquina — los mismos comandos escritos
						allí, y la puerta por la que entra la consola de aquí. Tres variables de entorno son lo
						que la consola sobrescribe cuando el plano va a vivir a su lado: <code>SQUAD_DIR</code>,{" "}
						<code>SQUAD_STATE</code> y <code>SQUAD_SHIM</code>. Esa es toda la diferencia entre un
						equipo y un VPS.
					</p>
					<p className="small muted">
						En cualquiera de los dos extremos que lo hayas ejecutado, la consola es el comando de
						arriba y esta máquina es una respuesta que guarda — en <code>~/.squad/plane.json</code>,
						escrita una vez y nunca vuelta a preguntar. <code>squad connect</code> vuelve a
						preguntar, y el instalador imprime tu propia dirección cuando termina, así que no hay
						nada que ir a buscar.
					</p>
					<p className="small muted">
						Volver a ejecutar ese instalador es la actualización, y <code>squad update</code> lo
						ejecuta en la máquina donde esté el plano. Trae lo último, reconstruye las dos imágenes
						y sustituye el plano; <code>config.yaml</code> y <code>.env</code> se quedan exactamente
						como están, así que nada de lo que concediste o le diste desaparece.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Una vez que estás en ella</span>
					<h2>Entonces escribes su nombre</h2>
					<p>
						La superficie de control es un socket unix dentro del directorio de estado y nunca sale
						de la máquina. No hay puerto que abrir, ni token que emitir, ni nada en lo que iniciar
						sesión: cuando el plano está en un servidor, SSH ya decide quién puede tocar ese host, y
						tocar ese host es lo que significa tener el socket. <code>squad relay</code> es la vía
						de entrada de la consola — el mismo socket sobre un par de tuberías, corriendo por la
						conexión que ya tienes.
					</p>
					<p>
						Todo lo que hace la consola viaja por esa única conexión: la lista de agentes, el feed
						de logs, la conversación, <code>/limit</code>, <code>/model</code>, <code>/mcp</code>,{" "}
						<code>/serve</code>, y <code>!</code> hacia el sandbox mismo.
					</p>
					<p className="small muted">
						<code>/serve 3000</code> es esa conexión leída al revés. Un agente que construye una
						página no tiene dónde ponerla — la red del sandbox no tiene rutas y nada se publica
						fuera del servidor — así que la consola abre el puerto en <em>tu</em> loopback en su
						lugar, e imprime <code>http://scout.localhost:3000</code>. El enlace funciona en el
						equipo en el que se imprimió y en ningún otro sitio, y se cierra cuando cierras la
						consola.
					</p>
					<p className="small muted">
						No tienes que saber que esos comandos existen. Un agente que necesita un servidor de
						herramientas puede pedirlo él mismo, y la pantalla de consentimiento se abre en tu
						navegador de aquí — el agente no llega más allá de ponerte la pregunta delante.
						Cualquier cosa que ampliara su alcance sigue estando en tus manos escribirla, y pedir
						una te imprime la línea.
					</p>
					<div className="note">
						<p>
							<strong>Por qué no hay una interfaz web en la que iniciar sesión.</strong> El plano de
							control tiene el socket de Docker, así que equivale a root en la máquina — la frontera
							de confianza es el sandbox alrededor del agente, no el proceso que lo gestiona.
							Publicar esa superficie de control pondría root en internet detrás de una contraseña
							que alguien eligió. SSH es la misma autenticación que ya guarda la máquina, y es más
							fuerte.
						</p>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">El único archivo que editar</span>
					<h2>Di qué puede alcanzar un agente</h2>
					<p>
						<code>/opt/squad/deploy/config.yaml</code> es toda la superficie: los agentes, qué puede
						alcanzar cada uno, qué modelos hay con los que pensar, cuándo despierta cada uno, qué
						webhooks existen, y — bajo <code>defaults</code> — de qué parte un agente creado después
						desde el teclado. El instalador escribe uno que funciona; esta es su forma.
					</p>
					<Code label="deploy/config.yaml">{`
models:
  - id: deepseek-v4-flash      # nombrar el proveedor dice el resto
    provider: deepseek
  - id: sonnet
    provider: anthropic
    model: claude-sonnet-4-6
  - id: gpt-5
    provider: openai

defaults:
  model: deepseek-v4-flash     # /model mueve un agente a otro
  limitUsd: 5                  # dólares al día, reiniciado a medianoche UTC
  grants:
    - id: web                  # la carretera: npm, PyPI, git, donde sea
      host: "*"
      injection:
        kind: none             # y ninguna clave tuya baja por ella
    - id: search
      host: api.openai.com
      pathPrefix: /v1/responses  # el único endpoint que busca
      methods: [POST]
      injection:
        kind: bearer
        token: { ref: OPENAI_API_KEY }
`}</Code>
					<p className="small">
						Qué se puede alcanzar y qué se puede gastar son dos preguntas, y solo la primera se
						responde con "donde sea". Una concesión sobre <code>*</code> que llevara una credencial
						se rechaza cuando se lee el archivo: la carretera está abierta, las claves se dan a un
						sitio por su nombre. Borra la concesión <code>web</code> y el plano vuelve a denegar por
						defecto, host por host.
					</p>
					<p className="small">
						No hay ningún secreto dentro. Nombra variables de entorno y el proceso tiene los
						valores, así que el archivo que describe qué puede alcanzar un agente cabe en un commit
						y se lee en un diff — una concesión que nadie vio añadirse es el modo de fallo.
					</p>
					<p className="small">
						Los tres están listados tenga o no este plano sus claves, porque listar uno es la
						aprobación y la clave es solo lo que lo hace responder. Un modelo al que le falta su
						clave se rechaza en el proxy hasta que alguien dé una, y la pantalla de configuración de{" "}
						<code>squad</code> — <code>tab</code> pasados los logs — es la lista de cuáles están
						esperando, y donde se pega una clave. Vale desde el turno siguiente, sin reiniciar nada
						y sin tocar este archivo.
					</p>
					<p className="small">
						Esa pantalla también añade modelos, en la fila que dice <code>+ a model</code> — y les
						pregunta a los proveedores en vez de preguntarte a ti. Que te den una clave y luego te
						pidan un nombre de modelo es que te pidan el único dato que la clave acaba de permitirle
						consultar al plano, así que a cada proveedor del que tiene una clave se le pregunta a
						qué responde, y lo que vuelve es una lista por la que moverse con las flechas. Escribir
						la estrecha contra el proveedor y el id a la vez, de modo que <code>openai mini</code>{" "}
						llega sin recordar el id exacto. Escribir uno entero sigue funcionando, para un
						proveedor sin catálogo al que preguntar.
					</p>
					<p className="small">
						Así que este archivo es donde va un modelo para sobrevivir a un redespliegue, y la
						consola es donde va uno cuando lo quieres en el turno siguiente. Un modelo añadido allí
						se guarda junto a este archivo en vez de escribirse dentro, y un modelo que este archivo
						declara es uno que la consola leerá y se negará a tocar.
					</p>
					<p className="small muted">
						Se lee cuando arranca el plano, así que una edición surte efecto con{" "}
						<code>docker compose restart control-plane</code> desde <code>/opt/squad/deploy</code>.
					</p>
					<div className="note warn">
						<p>
							<strong>El techo ya está ahí. Déjalo.</strong> Un agente puede reservar su propio
							turno siguiente, así que sin <code>limitUsd</code> lo primero que se sabe de un bucle
							es la factura. Está bajo <code>defaults</code> para que cubra también a los agentes
							creados después desde el teclado, que son exactamente aquellos a los que nadie se
							acuerda de ponerles un techo.
						</p>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Desde cualquier otro sitio</span>
					<h2>Despertar a un agente con un webhook</h2>
					<p>
						El puerto <code>8787</code> es lo único publicado, y solo acepta peticiones firmadas. El
						instalador genera el secreto y lo pone en <code>.env</code> como{" "}
						<code>HOOK_SECRET</code>. La firma cubre{" "}
						{/* biome-ignore lint/suspicious/noTemplateCurlyInString: the shape of the signed string */}
						<code>{"${timestamp}.${body}"}</code> y se compara en tiempo constante dentro de una
						ventana de frescura; un id de hook desconocido responde exactamente igual que una firma
						mala, y solo después de haber leído el cuerpo, así que el endpoint no enumera.
					</p>
					<Code wrap>{`
BODY='{"text":"the nightly build failed"}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HOOK_SECRET" -r | cut -d' ' -f1)"

curl -X POST https://your-vps:8787/hooks/ping \\
  -H "x-squad-timestamp: $TS" \\
  -H "x-squad-signature: $SIG" \\
  -d "$BODY"
`}</Code>
					<p className="small muted">
						Un webhook no puede llevar confianza de operador, por bien firmado que esté. El secreto
						prueba qué sistema envió la petición, nunca que un humano quisiera decir lo que hay
						dentro — así que el cuerpo llega vallado, como datos. Los eventos se encolan por agente
						y se pliegan en un solo turno, y un turno que falla deja sus eventos encolados en vez de
						darlos por recibidos, así que una clave mala cuesta un reintento en vez del mensaje.
					</p>
					<p className="small muted">
						Las otras dos vías de entrada no necesitan nada publicado, porque salen ellas en vez de
						ser alcanzadas: <code>/telegram &lt;token&gt;</code> conecta un bot al agente que estás
						mirando, y <code>/email &lt;address&gt;</code> conecta un buzón a todos los agentes del
						plano. Ambas se emparejan con una persona mediante una frase, y ambas pueden instruir
						una vez emparejadas.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Antes del VPS</span>
					<h2>O prueba todo esto en tu equipo</h2>
					<p>
						La demo construye las imágenes, arranca un plano de control en una red desechable,
						muestra qué puede y qué no puede alcanzar el agente, lo despierta con un webhook firmado
						e imprime el turno. Pide una clave de modelo cuando llega a la parte que necesita una.
					</p>
					<Code>{`
$ git clone ${REPO}
$ cd squad
$ ./deploy/demo.sh up
`}</Code>
					<p className="small muted">
						<code>./deploy/demo.sh down</code> borra los contenedores, las redes, el volumen y el
						estado. La única diferencia con un despliegue real es dónde vive el estado: bajo el
						árbol de trabajo, porque <code>/var/lib</code> necesita root y no se comparte con Docker
						Desktop en macOS.
					</p>
				</div>
			</section>

			<section id="by-hand">
				<div className="wrap">
					<span className="eyebrow">Si prefieres no canalizar un script a un shell</span>
					<h2>La misma instalación, a mano</h2>
					<p>
						Cuatro comandos y los dos archivos que el instalador habría escrito por ti. Todo lo de
						arriba sigue valiendo — esto es solo la parte que trae y arranca.
					</p>
					<Code>{`
$ git clone ${REPO} /opt/squad && cd /opt/squad
$ docker build -t squad/sandbox:dev packages/sandbox/image
$ cd deploy
$ cp .env.example .env                # las claves que inyecta el proxy
$ cp config.example.yaml config.yaml  # qué puede alcanzar cada agente
$ docker compose up -d --build
`}</Code>
					<p className="small muted">
						<code>config.example.yaml</code> es la referencia, con todas las opciones comentadas, y
						su agente de ejemplo alcanza hosts que no son tuyos — léelo entero antes de arrancar y
						no después. Sin el instalador tampoco hay <code>squad</code> en el PATH, así que la
						consola es <code>docker compose exec control-plane squad</code>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Si editas el archivo de compose</span>
					<h2>Dos cosas son estructurales</h2>
					<ul className="list">
						<li>
							<strong>El plano de control corre en la red de los agentes</strong>, no en el host.
							Los contenedores de una red interna no llegan al host en absoluto, así que un proxy en
							el host es uno que los agentes no pueden usar.
						</li>
						<li>
							<strong>El directorio de estado se monta por bind en su propia ruta.</strong> El plano
							le pasa esa ruta al daemon cuando monta la CA en un sandbox, y el daemon resuelve los
							orígenes de bind en el host, así que una ruta de contenedor cómoda produce montajes
							que el daemon no encuentra.
						</li>
					</ul>
					<div className="jump-row">
						<Link href="/es/" className="jump">
							← qué es
						</Link>
						<a href={REPO} className="jump">
							el README, entero
						</a>
					</div>
				</div>
			</section>
		</Layout>
	);
}
