import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Search() {
	return (
		<Docs
			title="Búsqueda web"
			lede="Alcanzar la web no es lo que hace que un agente pueda buscar. Traer diez resultados y leerlos es un trabajo, y un agente que lo hace a mano gasta todo su contexto en la lectura antes de llegar al pensamiento."
			description="Cómo funciona web_search: un proveedor alojado elegido en la pantalla de configuración, un endpoint concedido y la lectura hecha al otro lado."
		>
			<section>
				<span className="eyebrow">Por qué es una herramienta</span>
				<h2>La búsqueda y la lectura ocurren en otro sitio</h2>
				<p>
					<code>web_search</code> es una extensión de pi que viaja en la imagen del sandbox, como{" "}
					<code>wake_me</code>. Envía la pregunta a una búsqueda alojada que lee las páginas ella
					misma y responde en prosa con sus fuentes enlazadas — así que lo que vuelve al contexto
					del agente es una respuesta en vez de diez páginas de HTML.
				</p>
			</section>

			<section>
				<span className="eyebrow">Configurarlo</span>
				<h2>Elegir el proveedor es todo lo que hay</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ Choosing here is the whole of setting it up — the host, the    │
│ key and what a search costs come with the provider, and the    │
│ proxy is told to pay for that one endpoint and nothing else.   │
│                                                                │
│ ● provider   openai                                            │
│ ● model      gpt-5-mini                                        │
│ ● key        OPENAI_API_KEY                                    │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ 2 to search with   $0.010 a search here                    │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					Dónde vive ese proveedor, el único endpoint suyo que busca, la variable de la que se lee
					su clave y lo que cuesta una búsqueda son hechos del proveedor y no decisiones, así que
					ninguno se pregunta. El punto es el mismo en las tres filas porque ninguna está en vigor
					sin la clave — un proveedor y un modelo elegidos contra una clave que este plano no tiene
					son una búsqueda rechazada en el proxy, y una marca que lo diga es mejor que dos que se
					contradigan.
				</p>
				<p>
					Lo que el plano deriva de esa pantalla es <code>api.openai.com</code>,{" "}
					<code>POST /v1/responses</code>, bearer desde <code>OPENAI_API_KEY</code> — y{" "}
					<Link href="/es/docs/grants/">el alcance de la ruta</Link> es la parte que vale la pena
					conservar. La misma clave contra el resto de esa API es un segundo modelo con el que
					pensar, comprado por quien se apodere del agente, y una concesión que solo abre el
					endpoint que busca es una que no puede gastarse en ninguna otra cosa.
				</p>
				<p className="small muted">
					Todo agente la recibe, porque es una herramienta y no un alcance: la pregunta va a un solo
					host y la respuesta vuelve, y ningún agente se estrecha por quedarse sin ella. Escribir la
					concesión a mano en <code>deploy/config.yaml</code> sigue funcionando y sigue ganando, si
					querés el endpoint fijado en un sitio que una consola no pueda mover.
				</p>
			</section>

			<section>
				<span className="eyebrow">Dos detalles que se notan</span>
				<h2>curl, y un fallo dicho en voz alta</h2>
				<p>
					La herramienta llega al proxy con <code>curl</code> y no con <code>fetch</code>, porque un
					sandbox no tiene DNS ni salida más que ese proxy: el <code>fetch</code> de Node no lee ni{" "}
					<code>HTTPS_PROXY</code> ni <code>NODE_EXTRA_CA_CERTS</code> y muere resolviendo el
					nombre. Nada envía un <code>Authorization</code> — el proxy escribe uno y quita el que se
					haya enviado, así que un agente con una clave no podría gastarla y este no tiene ninguna.
				</p>
				<p className="small muted">
					Sin la concesión la herramienta sigue ahí y dice en el momento de usarla que no pudo
					buscar, que es mejor fallo que un agente respondiendo en silencio de memoria. Cada
					búsqueda se cobra por llamada, y por eso la herramienta pide una pregunta y no palabras
					clave que probar — y lo que cuesta cae en{" "}
					<Link href="/es/docs/limits/">el día del agente</Link> como todo lo demás.
				</p>
			</section>
		</Docs>
	);
}
