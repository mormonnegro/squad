import Link from "next/link";
import { Code } from "../../components/Code";
import { Layout } from "../../components/Layout";
import { CLIENT, CONSOLE, IMAGES, INSTALL, REPO } from "../../lib/site";

const FLAGS: [string, string][] = [
	[
		"--name=casa",
		"un segundo despliegue en una misma máquina — sus propios contenedores, volúmenes, redes, puertos y agentes",
	],
	[
		"--domain=agents.example.com",
		"ponelo detrás de ese nombre, con un certificado que renueva solo",
	],
	["--domain=", "devolvé el nombre: se quita el proxy y el plano vuelve a estar en loopback"],
	[
		"--relay=https://relay.example.com",
		"alcanzalo por un punto de encuentro: nada publicado, nada reenviado, sin dominio",
	],
	["--verbose", "cada ruta, cada archivo que escribió, y el build en vivo en lugar de guardado"],
	[
		"--build",
		"construí las imágenes acá en vez de bajarlas, que es lo que hace falta para trabajar en el código",
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
			description="Un comando en la máquina donde van a vivir los agentes. No pregunta nada, baja dos imágenes, y termina imprimiendo la dirección de una consola."
		>
			<section className="hero">
				<div className="wrap">
					<h1>Instalar</h1>
					<p className="lede">
						Un comando, en la máquina donde van a vivir los agentes. No pregunta nada y termina
						imprimiendo una sola dirección — que es la consola, y la llave para entrar.
					</p>
					<div className="hero-meta">
						<span>Sin preguntas</span>
						<span>~1 GB de RAM</span>
						<span>Sin cuenta, sin claves que tener a mano</span>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">En la máquina que los va a correr</span>
					<h2>Un comando, y no pregunta nada</h2>
					<Code label="en tu laptop, o en tu servidor" wrap>{`
$ curl -fsSL ${INSTALL} | sh
`}</Code>
					<p>
						Docker si la máquina no tiene, dos imágenes{" "}
						<a href={IMAGES}>bajadas en vez de construidas</a>, una configuración con un agente y un
						techo de cinco dólares al día, y un plano andando. Medio minuto en una máquina que ya
						tiene Docker.
					</p>
					<p>
						<strong>No pide ninguna clave.</strong> Una clave no es algo que necesites antes de que
						la cosa corra — es lo que este plano puede pagar, cambia, y un plano la acepta mientras
						está andando. Tres secretos en el primer minuto las hacían parecer requisitos, que es lo
						único que no son. Se dan en la consola, en la pantalla que existe para eso, y el plano
						la está usando desde el turno siguiente al que la escribís.
					</p>
					<p className="small muted">
						Volver a correrlo es la actualización: baja, cambia el plano, y deja{" "}
						<code>config.yaml</code> intacto junto con cada clave y cada edición de{" "}
						<code>.env</code>. Solo se ponen al día las líneas que dicen qué <em>es</em> esta
						instalación — qué imágenes, qué dominio — porque un archivo que no coincide con el plano
						que está corriendo es un <code>docker compose up</code> a mano que arranca el código del
						mes pasado sin decir nada.
					</p>
					<div className="note">
						<p>
							<strong>Que no haya nada publicado para bajar no es un error.</strong> Un registry
							caído, un tag que todavía no existe, un fork que no publica nada — el instalador lo
							dice y construye desde las fuentes, que están ahí mismo. Ese camino es más lento y
							sigue funcionando, que es justamente para qué se lo mantiene.
						</p>
					</div>
				</div>
			</section>

			<section id="console">
				<div className="wrap">
					<span className="eyebrow">Lo que imprime</span>
					<h2>El plano sirve su propia consola</h2>
					<Code wrap>{`
Getting in
  Open this, or paste it into a console you host yourself:

    http://127.0.0.1:8789/?t=MekEy-WJ4RPyWP3PjCEntVGhlJN56bE0uNffl2Obhls
`}</Code>
					<p>
						La abrís y la consola está ahí — los agentes, las conversaciones, qué está haciendo cada
						uno y cuánto gastó. La sirve el plano mismo, desde su propio contenedor, así que no hay
						nada más que instalar ni nada nuestro entre vos y eso.
					</p>
					<p>
						<strong>Esa dirección es la llave.</strong> El plano escribe un token al arrancar, en un
						archivo <code>0600</code> que solo root puede leer, y tenerlo es ser el operador — el
						protocolo no tiene login propio ni lo quiere. Por eso se pega, no se postea. La página
						lo cambia por una cookie y limpia la URL, porque una dirección se copia y queda en un
						historial y una cookie no.
					</p>
					<p>
						Las claves entran desde ahí: el selector de ambiente, y después <strong>Keys</strong>.
						Cada proveedor dice si este plano tiene una y si se la escribió acá o la exportó la
						máquina, y ninguno muestra nunca un valor — el plano contesta con el nombre de la clave
						que puso y jamás con la clave. Un plano que no tiene ninguna lo dice arriba de la
						conversación, porque la alternativa es un turno que se muere en el modelo por un motivo
						que la pantalla ya sabía.
					</p>
					<p className="small muted">
						Hay una copia de la misma consola en <a href={CONSOLE}>{CONSOLE}</a>. Sostiene varios
						ambientes a la vez y se mueve entre ellos, que es lo único que hace y que la que sirve
						tu plano no. Es una comodidad, no la puerta: lo que sabe vive en tu navegador y en
						ningún otro lado, tampoco acá.
					</p>
				</div>
			</section>

			<section id="server">
				<div className="wrap">
					<span className="eyebrow">Si está en un servidor</span>
					<h2>Dale un nombre, o reenviá el puerto</h2>
					<p>
						El puerto de la consola se publica en el loopback del servidor y en ningún otro lado. Es
						a propósito: el plano tiene el socket de Docker, así que equivale a root en esa máquina,
						y publicarlo sería poner root en internet detrás de un token que viaja en texto plano.
						Hay dos maneras de alcanzarla, y la primera es mejor.
					</p>
					<Code label="con un nombre propio" wrap>{`
$ curl -fsSL ${INSTALL} | sh -s -- --domain=agents.example.com
`}</Code>
					<p>
						Apuntá el DNS a la máquina primero, y después corré eso. Un proxy delante del plano
						obtiene un certificado y lo renueva, y la instalación termina con un solo{" "}
						<code>https://agents.example.com/?t=…</code>. Nada que reenviar, nada que dejar abierto,
						y funciona desde cualquier navegador.
					</p>
					<p className="small muted">
						El proxy es un profile de compose, así que una máquina a la que nunca le dieron un
						dominio no lo arranca y nunca toma el puerto 80 esperando un certificado que no va a
						llegar. La exposición del plano no cambia: lo que se publica es el proxy.
					</p>
					<p>
						<strong>Y si no tiene ni dominio ni una terminal que quieras dejar abierta</strong>, el
						plano puede discar para afuera: <code>--relay=https://relay.example.com</code> hace que
						se encuentre con una consola en un punto de encuentro, que funciona detrás de un NAT
						porque no se publica nada en ninguna de las dos puntas. Termina imprimiendo un código en
						vez de una dirección, porque no hay dirección que dar.
					</p>
					<p className="small muted">
						Lo que cruza un relay va sellado con una clave que las dos puntas derivan del token de
						este plano. Al relay se le da un número de sala derivado en un solo sentido de ese mismo
						token — suficiente para unir dos sockets y no para recuperar nada — así que lleva el
						tráfico y no puede leerlo. Está apagado salvo que lo pidas, y{" "}
						<a href={`${REPO}/tree/main/packages/relay`}>
							el que corremos nosotros es el que está en el repositorio
						</a>
						, que es la única razón para creer algo de esto.
					</p>
					<Code label="o reenvialo por el SSH que ya tenés" wrap>{`
$ ssh -N -L 18789:127.0.0.1:8789 vos@tu-servidor
`}</Code>
					<p>
						Eso corrélo en tu propio equipo — no en el servidor, donde ese puerto ya es del plano.
						Después abrís <code>http://127.0.0.1:18789/?t=…</code> con el token que imprimió el
						servidor: tu puerto, su llave. Sirve cualquier puerto local libre.
					</p>
					<p className="small muted">
						La dirección dice <code>127.0.0.1</code> porque, después del reenvío, eso es el
						servidor. En el servidor no se abre nada — comprobalo allá con <code>ss -ltn</code> — y
						no hay nada nuevo a lo que loguearse, porque los bytes cruzan la conexión que ya tenías.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">El resto del comando</span>
					<h2>Cinco flags, y ningún archivo de configuración que escribir antes</h2>
					<table className="table">
						<tbody>
							{FLAGS.map(([flag, what]) => (
								<tr key={flag}>
									<td>
										<code>{flag}</code>
									</td>
									<td>{what}</td>
								</tr>
							))}
						</tbody>
					</table>
					<Code wrap>{`
$ curl -fsSL ${INSTALL} | sh -s -- --name=casa
`}</Code>
					<p className="small muted">
						Flags y no solo variables de entorno, por la forma en que esto se corre:{" "}
						<code>SQUAD_NAME=casa curl … | sh</code> le pone la variable a <code>curl</code>, y el
						shell que lee el script nunca la ve. La instalación se va al nombre por defecto y no
						dice nada, que se parece exactamente a un éxito hasta que hay dos despliegues y el
						segundo pisó al primero. Un flag cruza el pipe. Las variables siguen funcionando cuando
						no hay pipe.
					</p>
					<p className="small muted">
						Un segundo despliegue no comparte nada con el primero salvo el demonio de Docker — sus
						propios contenedores, volúmenes, redes, estado y agentes, en puertos derivados de su
						nombre. <code>SQUAD_VERSION</code> fija qué build publicado correr; si no lo tocás, es
						el release más nuevo.
					</p>
				</div>
			</section>

			<section id="a-machine">
				<div className="wrap">
					<span className="eyebrow">Si aún no tenés una</span>
					<h2>La máquina cuesta cinco dólares al mes</h2>
					<p>
						Un vCPU, un gigabyte de memoria y diez de disco alcanzan para unos cuantos agentes, y
						eso es lo más barato de la lista de cualquier proveedor. Necesita un Linux con SSH y
						nada más — el instalador trae Docker. Una laptop vieja abajo del escritorio también
						sirve.
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
						Los precios se mueven; la forma de la cuenta no. La máquina es un número fijo al mes, y
						el único otro costo es aquello con lo que piensan los agentes — medido por el proveedor
						de modelo al que le des una clave, y limitado por <code>limitUsd</code> a cinco dólares
						al día por agente. Por squad no se paga nada.
					</p>
					<p className="small muted">
						Un gigabyte alcanza porque la instalación baja en vez de construir. Construir en esa
						máquina significa un árbol de dependencias y un bundler corriendo ahí, que en el fondo
						de la lista es un build muerto por memoria — y muerto en el medio, que es el peor lugar
						donde una instalación puede pararse.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">El único archivo que editar</span>
					<h2>Decí qué puede alcanzar un agente</h2>
					<p>
						<code>/opt/squad/deploy/config.yaml</code> es toda la superficie: los agentes, qué puede
						alcanzar cada uno, qué modelos hay para pensar, cuándo despierta cada cual, qué webhooks
						existen, y — bajo <code>defaults</code> — de qué parte un agente creado después en el
						teclado. El instalador escribe uno que ya funciona; esta es su forma.
					</p>
					<Code label="deploy/config.yaml">{`
models:
  - id: deepseek-v4-flash      # naming the provider says the rest
    provider: deepseek
  - id: sonnet
    provider: anthropic
    model: claude-sonnet-4-6
  - id: gpt-5
    provider: openai

defaults:
  model: deepseek-v4-flash     # /model moves one agent onto another
  limitUsd: 5                  # dollars a day, reset at midnight UTC
  grants:
    - id: web                  # the road: npm, PyPI, git, anywhere
      host: "*"
      injection:
        kind: none             # and no key of yours goes down it
    - id: search
      host: api.openai.com
      pathPrefix: /v1/responses  # the one endpoint that searches
      methods: [POST]
      injection:
        kind: bearer
        token: { ref: OPENAI_API_KEY }
`}</Code>
					<p className="small">
						Qué se puede alcanzar y qué se puede gastar son dos preguntas, y solo la primera se
						contesta "en cualquier lado". Un grant sobre <code>*</code> que llevara una credencial
						se rechaza cuando se lee el archivo: el camino está abierto, las claves se dan a un
						lugar por su nombre. Borrá el grant <code>web</code> y el plano vuelve a negar por
						defecto, host por host.
					</p>
					<p className="small">
						No hay ningún secreto adentro. Nombra variables de entorno y el proceso tiene los
						valores, así que el archivo que describe qué puede alcanzar un agente se puede commitear
						y diffear — un grant que nadie notó que se agregaba es el modo en que esto falla.
					</p>
					<p className="small">
						Los tres modelos aparecen tenga o no este plano sus claves, porque listar uno es la
						aprobación y la clave es solo lo que lo hace contestar. <a href="#console">Keys</a> en
						la consola es donde se pega una, y rige desde el turno siguiente sin reiniciar nada y
						sin tocar este archivo.
					</p>
					<p className="small muted">
						Se lee cuando el plano arranca, así que una edición toma efecto con{" "}
						<code>docker compose restart control-plane</code> desde <code>/opt/squad/deploy</code>.
					</p>
					<div className="note warn">
						<p>
							<strong>El techo ya está puesto. Dejalo.</strong> Un agente puede agendar su propio
							turno siguiente, así que sin <code>limitUsd</code> lo primero que alguien sabe de un
							bucle es la factura. Está bajo <code>defaults</code> para que también cubra a los
							agentes creados después en el teclado, que son justo los que nadie se acuerda de
							limitar.
						</p>
					</div>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Desde cualquier otro sitio</span>
					<h2>Despertar a un agente con un webhook</h2>
					<p>
						El puerto <code>8787</code> es lo único publicado a la red, y solo acepta pedidos
						firmados. El instalador genera el secreto y lo pone en <code>.env</code> como{" "}
						<code>HOOK_SECRET</code>. La firma cubre{" "}
						{/* biome-ignore lint/suspicious/noTemplateCurlyInString: the shape of the signed string */}
						<code>{"${timestamp}.${body}"}</code> y se compara en tiempo constante dentro de una
						ventana de frescura; un id de hook desconocido contesta exactamente igual que una firma
						mala, y solo después de leer el cuerpo, para que el endpoint no se pueda enumerar.
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
						prueba qué sistema mandó el pedido, nunca que una persona quiso decir lo que hay adentro
						— así que el cuerpo llega vallado, como datos. Los eventos se encolan por agente y se
						juntan en un turno, y un turno que falla deja sus eventos encolados en vez de
						confirmarlos, así que una clave mala cuesta un reintento y no el mensaje.
					</p>
					<p className="small muted">
						Las otras dos puertas no necesitan publicar nada, porque salen en vez de ser alcanzadas:{" "}
						<code>/telegram &lt;token&gt;</code> conecta un bot al agente que estás mirando, y{" "}
						<code>/email &lt;dirección&gt;</code> conecta un buzón a todos los agentes del plano.
						Las dos se aparean a una persona con una frase, y las dos pueden instruir una vez
						apareadas.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Si preferís quedarte en la terminal</span>
					<h2>La consola también fue siempre un comando</h2>
					<p>
						El mismo plano, el mismo protocolo, otra pantalla. El instalador deja <code>squad</code>{" "}
						en el PATH de la máquina donde corrió, y esto pone la misma consola en el equipo ante el
						que estás sentado — donde pregunta qué plano manejar y se guarda la respuesta.
					</p>
					<Code label="en tu laptop" wrap>{`
$ curl -fsSL ${CLIENT} | sh
$ squad
`}</Code>
					<p className="small muted">
						Necesita Node 22.18 o más nuevo y nada más — ningún Docker, esté donde esté el plano. A
						un plano en un servidor se lo alcanza por <code>ssh vps squad relay</code>, que es el
						mismo protocolo sobre la conexión que ya tenés, así que tampoco para esto se abre nada
						allá.
					</p>
					<p className="small muted">
						<code>/serve 3000</code> es esa conexión leída al revés: la red del sandbox no rutea,
						así que la consola abre el puerto en <em>tu</em> loopback y escribe{" "}
						<code>http://scout.localhost:3000</code> — un enlace que funciona en la máquina donde se
						imprimió y en ninguna otra, y que se cierra cuando cerrás la consola.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Antes del VPS</span>
					<h2>O probá todo esto en tu equipo</h2>
					<p>
						La demo construye las imágenes, levanta un plano de control en una red descartable,
						muestra qué puede y qué no puede alcanzar el agente, lo despierta con un webhook firmado
						e imprime el turno. Pide una clave de modelo cuando llega a la parte que la necesita.
					</p>
					<Code>{`
$ git clone ${REPO}
$ cd squad
$ ./deploy/demo.sh up
`}</Code>
					<p className="small muted">
						<code>./deploy/demo.sh down</code> borra los contenedores, las redes, el volumen y el
						estado. La única diferencia con un despliegue real es dónde vive el estado: bajo el
						árbol de trabajo, porque <code>/var/lib</code> necesita root y no está compartido con
						Docker Desktop en macOS.
					</p>
				</div>
			</section>

			<section id="by-hand">
				<div className="wrap">
					<span className="eyebrow">Si preferís no canalizar un script a un shell</span>
					<h2>La misma instalación, a mano</h2>
					<p>
						El repositorio, los dos archivos que el instalador habría escrito por vos, y un{" "}
						<code>up</code>. Todo lo de arriba sigue aplicando — esto es solo la parte que baja y
						arranca.
					</p>
					<Code>{`
$ git clone ${REPO} /opt/squad && cd /opt/squad/deploy
$ cp .env.example .env                # ports, the webhook secret, the origins
$ cp config.example.yaml config.yaml  # what each agent may reach
$ docker compose up -d
`}</Code>
					<p className="small muted">
						<code>SQUAD_IMAGE</code> y <code>SQUAD_SANDBOX_IMAGE</code> en <code>.env</code> dicen
						qué imágenes correr; si no las tocás son las construidas localmente, y{" "}
						<code>docker compose build</code> las hace. Apuntalas a{" "}
						<a href={IMAGES}>las publicadas</a> para saltear el build.
					</p>
					<p className="small muted">
						<code>config.example.yaml</code> es la referencia, con cada opción comentada, y su
						agente de ejemplo alcanza hosts que no son tuyos — leelo entero antes de arrancar y no
						después. Sin el instalador tampoco hay <code>squad</code> en el PATH, así que la consola
						es <code>docker compose exec control-plane squad</code>.
					</p>
				</div>
			</section>

			<section>
				<div className="wrap">
					<span className="eyebrow">Si editás el archivo de compose</span>
					<h2>Dos cosas son estructurales</h2>
					<ul className="list">
						<li>
							<strong>El plano de control corre en la red de los agentes</strong>, no en el host.
							Los contenedores de una red interna no pueden alcanzar el host de ninguna manera, así
							que un proxy en el host es uno que los agentes no pueden usar.
						</li>
						<li>
							<strong>El directorio de estado se monta en su propia ruta.</strong> El plano le pasa
							esa ruta al demonio cuando monta la CA en un sandbox, y el demonio resuelve los
							orígenes del bind en el host, así que una ruta de contenedor más cómoda produce
							montajes que el demonio no encuentra.
						</li>
					</ul>
					<div className="jump-row">
						<Link href="/es" className="jump">
							← qué es
						</Link>
						<a href={REPO} className="jump">
							el README, completo
						</a>
					</div>
				</div>
			</section>
		</Layout>
	);
}
