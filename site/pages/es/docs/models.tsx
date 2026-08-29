import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Models() {
	return (
		<Docs
			title="Modelos"
			lede="Un modelo es la única capacidad que todo agente necesita y la única en la que nadie piensa como capacidad. Nombrar un proveedor es todo lo que es configurarlo."
			description="Declarar modelos en el archivo de configuración o añadirlos desde la consola, darle una clave al plano y mover un agente a otro modelo con /model."
		>
			<section>
				<span className="eyebrow">Declarar uno</span>
				<h2>Una lista, y casi solo un proveedor</h2>
				<Code label="deploy/config.yaml">{`
models:
  - id: deepseek-v4-flash      # el id hace de modelo cuando ya lo es
    provider: deepseek

  - id: sonnet
    provider: anthropic
    model: claude-sonnet-4-6

defaults:
  model: deepseek-v4-flash     # donde empieza cada agente
`}</Code>
				<p>
					Antes eran cuatro cosas acopladas — el proveedor, el modelo, una clave de relleno en el
					entorno del sandbox y una concesión que nombraba el host del proveedor — y cualquiera de
					ellas mal no es un error de arranque sino un turno que muere en el proxy, quejándose de
					algo que el operador nunca escribió. Dónde vive un proveedor, cómo se llama su clave y si
					la clave va en una cabecera bearer o en una propia son hechos sobre el proveedor y no
					decisiones que nadie pueda tomar, así que no se escriben.
				</p>
				<p className="small muted">
					Un proveedor que aquí no conoce nadie funciona igual diciendo las dos cosas que habría
					dicho la tabla: un <code>host</code> y un <code>keyEnv</code>. La clave en sí nunca está
					en este archivo ni en el agente — <code>keyEnv</code> nombra una variable del entorno del
					propio plano de control, y la concesión que produce cada modelo es lo que la escribe en la
					petición al salir.
				</p>
			</section>

			<section>
				<span className="eyebrow">Mover un agente</span>
				<h2>/model es una elección entre lo que existe</h2>
				<Screen>{`
 ▸ /model flash   deepseek/deepseek-v4-flash   (this one)
   /model sonnet  anthropic/claude-sonnet-4-6
   /model gpt-5   openai/gpt-5   (no OPENAI_API_KEY)
╭──────────────────────────────────────────────────────────────────────╮
│ > /model                                                             │
╰──────────────────────────────────────────────────────────────────────╯
 ↑↓ model   ⏎ choose   ^C quit
`}</Screen>
				<p>
					Cada fila dice los dos hechos sobre un modelo que no son su nombre — de quién es y cómo lo
					llaman — más el que decide si el turno siguiente responde siquiera. Un modelo del que este
					plano no tiene clave se ofrece y se marca, no se esconde, porque está configurado y la
					mitad que falta es una clave que puedes pegar dos paneles más allá. Al escribir se
					estrecha la lista contra el id, el proveedor y el nombre propio del proveedor a la vez,
					así que <code>/model anthropic</code> encuentra el que se llama <code>sonnet</code>.
				</p>
				<p>
					Todos los modelos de esa lista ya son alcanzables por todos los agentes — configurar uno
					es lo que lo concedió — así que moverse entre ellos cambia lo que cuesta un turno y lo
					bueno que es, y no cambia nada de lo que el agente puede alcanzar. Eso es lo que lo hace
					un comando y no una edición y un reinicio, y es por lo que a un agente se le permite
					pedirlo.
				</p>
				<p className="small muted">
					No se recrea nada para hacerlo. El contenedor se arrancó con un relleno para cada
					proveedor que esto conoce, y el runner pregunta con qué pensar al principio de cada turno
					— así que un cambio aterriza en el turno siguiente, y un turno que ya está corriendo
					termina con el modelo que se le dio al empezar. Esa última parte se dice en voz alta,
					porque el cambio parece instantáneo y no lo es.
				</p>
			</section>

			<section>
				<span className="eyebrow">Las claves</span>
				<h2>Las dos mitades son una lista en la pantalla de configuración</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ holds from the next turn — nothing restarts.                   │
│                                                                │
│ providers                                                      │
│ ● deepseek   DEEPSEEK_API_KEY   flash                          │
│ ○ anthropic  ANTHROPIC_API_KEY  sonnet                         │
│ ○ openai     OPENAI_API_KEY     gpt-5                          │
│ ○ groq       GROQ_API_KEY       no models                      │
│                                                                │
│ models                                                         │
│ ● flash   deepseek   from the file                             │
│ ○ sonnet  anthropic  from the file                             │
│ ○ gpt-5   openai     added here                                │
│ + a model                                                      │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ ANTHROPIC_API_KEY   no key, refused at the proxy           │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					Un modelo son tres líneas de configuración y una variable exportada, y la variable es la
					mitad que no está en el archivo — así que es la mitad que se olvida. El fallo que eso
					produce es un plano que está corriendo y configurado y rechazado en el proxy, con turnos
					que mueren por un host que nadie escribió. <code>●</code> es algo que este plano puede
					usar ahora mismo y <code>○</code> algo que no, la misma marca que usa la columna de
					agentes.
				</p>
				<p>
					<code>⏎</code> sobre una clave la toma, enmascarada mientras se escribe y nunca vuelta a
					mostrar. Va al plano por el mismo socket por el que va un shell, y por la misma razón:
					tener ese socket es lo que hace a alguien el operador, y una clave que llegara por webhook
					sería un desconocido pagando con tu cuenta. Una clave pegada aquí rige desde el turno
					siguiente, sin nada reiniciado y nada redesplegado; una línea vacía la retira, y la
					pregunta vuelve a ir al entorno propio del plano.
				</p>
			</section>

			<section>
				<span className="eyebrow">Añadir uno desde el teclado</span>
				<h2>+ a model pregunta a los proveedores en vez de preguntarte a ti</h2>
				<Screen>{`
│ 3 on offer                                                     │
│ › gpt-5-mini   openai                                          │
│   gpt-4o-mini  openai                                          │
│   o4-mini      openai                                          │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ model  openai mini                                         │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					Que te tomen una clave y luego te pidan un nombre de modelo es que te pidan el único dato
					que la clave acaba de permitirle buscar al plano. Así que a cada proveedor del que tiene
					una clave se le pregunta a qué responde, todos a la vez, y lo que vuelve es una lista por
					la que moverse con las flechas. Al escribir se estrecha contra el proveedor y el id a la
					vez y en cualquier orden, así que <code>openai mini</code> llega sin recordar cuál de{" "}
					<code>gpt-5-mini</code> y <code>gpt-5-nano</code> era el bueno.
				</p>
				<p className="small muted">
					Un proveedor que no responda se nombra debajo de la lista en vez de contarse como que no
					tiene nada, ya que una lista vacía es la forma en la que llegan tanto una clave equivocada
					como un catálogo vacío. Escribir uno a mano sigue funcionando y tiene que hacerlo — tres
					palabras, un nombre, el proveedor con el que piensa y el nombre propio que el proveedor le
					da, así que <code>sonnet anthropic claude-sonnet-4-6</code> se toma tal cual se escribió.
				</p>
				<div className="note">
					<p>
						<strong>Lo que declaró el archivo está para leerse y no para cambiarse.</strong>{" "}
						<code>from the file</code> es una fila que esta pantalla no va a tapar y no va a soltar.
						Todo lo que se da aquí vive en un almacén junto a <code>config.yaml</code> y nunca
						dentro, así que un redespliegue devuelve lo que se escribió ahí y lo que se escribió
						aquí sobrevive al redespliegue por su cuenta. Esta es la única pantalla donde el teclado
						concede en vez de pagar, y es deliberado: llegar a ella significa tener el socket de
						control del plano, que es todo lo que es ser{" "}
						<Link href="/es/docs/trust/">el operador</Link> aquí.
					</p>
				</div>
			</section>
		</Docs>
	);
}
