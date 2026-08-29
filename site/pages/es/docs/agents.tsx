import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

const SELF: [string, string][] = [
	["agent.yaml", "nombre, modelo y las capacidades que le pide a un operador"],
	["soul.md", "quién es; se añade al prompt de sistema en cada turno"],
	["skills/", "carpetas con SKILL.md, cargadas por pi"],
	["memory/", "lo que eligió recordar, dividido por usuarios, proyectos y referencia"],
	["tools/", "scripts que escribió para sí mismo"],
];

export default function Agents() {
	return (
		<Docs
			title="Agentes"
			lede="Un contenedor que queda en marcha, un repositorio propio y un nombre. Crear uno es una fila en una pantalla; lo que puede alcanzar se decidió antes de que existiera."
			description="Crear un agente, qué guarda su repositorio, borrar una conversación y la diferencia entre un agente que declaraste y uno hecho desde el teclado."
		>
			<section>
				<span className="eyebrow">Crear uno</span>
				<h2>La fila debajo del último agente</h2>
				<p>
					Es una fila y no un comando porque es donde ya está mirando quien quiere un agente — sin
					ninguno es la única fila que hay, y la consola abre en ella. El panel que hay detrás toma
					un nombre y <code>⏎</code> lo construye: un contenedor, un repositorio propio, nada en su
					memoria, y exactamente lo que <code>defaults</code> en la configuración le permite
					alcanzar.
				</p>
				<p>
					El nombre es todo lo que el teclado decide acá, y por eso el panel lo dice. Puede nombrar
					a un agente y no puede concederle nada. Un nombre ya tomado, o que no es un nombre, se
					rechaza en el panel con el nombre todavía en el prompt para corregirlo, y lo que se
					construye aparece donde estaba el <code>+</code>, que es donde ya está el cursor.
				</p>
				<p className="small muted">
					Un plano sin <code>defaults</code> hace un agente que no puede alcanzar el modelo, y lo
					dice en el momento en que se crea y no a mitad de un turno. <code>squad chat maxi</code>{" "}
					en un shell es la misma oferta desde el otro extremo: nombrar un agente que no existe es
					lo que alguien escribe cuando quiere uno, así que pregunta.
				</p>
			</section>

			<section>
				<span className="eyebrow">De qué está hecho</span>
				<h2>Un repositorio propio</h2>
				<p>
					En su primer arranque un agente recibe un repositorio en su propio volumen, en{" "}
					<code>/home/agent/.self</code>:
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
					Se genera una vez, se inicializa con git y luego se deja en paz: lo que el agente aprende
					y lo que sabe hacer son archivos que él mismo edita y de los que hace commit. El plano de
					control no vuelve a escribir ahí, porque la segunda escritura sería el plano de control
					sobrescribiendo el trabajo del propio agente.
				</p>
				<p>
					Ese repositorio es el agente, no su escritorio. Los turnos empiezan al lado, en un segundo
					volumen en <code>/home/agent/workspace</code>, y la regla de la casa entra como argv en
					cada turno: un directorio por proyecto, nada suelto en la raíz, y ordená lo que encuentres
					desordenado en vez de dejarlo. Lo dice el plano en vez de estar escrito en{" "}
					<code>soul.md</code> porque el agente puede reescribir su alma, y una regla que el sujeto
					puede editar no es una regla.
				</p>
				<p className="small muted">
					Los dos volúmenes sobreviven al contenedor, que se reemplaza cada vez que cambia la
					imagen.
				</p>
				<div className="note">
					<p>
						<strong>Nada en ese repositorio concede nada.</strong> <code>agent.yaml</code> enumera{" "}
						<em>peticiones</em> de capacidades, y un operador las responde en{" "}
						<Link href="/es/docs/config/">el archivo de configuración</Link> que el agente no puede
						alcanzar. Un agente que puede editar su propia definición puede, si no, concederse
						capacidades a sí mismo, que es uno de los tres problemas que dan forma a todo el diseño.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">Declarado, o hecho acá</span>
				<h2>Dos clases de agente, y una de ellas está en tu archivo</h2>
				<p>
					Un agente puede ser un bloque en <code>config.yaml</code>, que es donde se escriben una
					descripción, sus propias concesiones, sus horarios y un techo más ajustado. O puede ser un
					nombre escrito en la fila de arriba, que el plano anota en su directorio de estado —
					porque el archivo de configuración es del operador y ningún plano puede escribirlo.
				</p>
				<Code label="deploy/config.yaml">{`
agents:
  - id: scout
    description: Watches the issue tracker and answers questions about it.
    grants:
      - id: github-issues
        host: api.github.com
        pathPrefix: /repos/acme/website/issues
        methods: [GET, POST]
        injection:
          kind: bearer
          token: { ref: GITHUB_TOKEN }
`}</Code>
				<p className="small muted">
					<code>description</code> se usa la primera vez que el agente arranca, para escribir su{" "}
					<code>soul.md</code>. Después de eso el repositorio es del agente y este archivo deja de
					opinar sobre quién es. Las concesiones propias de un agente se suman a las predeterminadas
					en vez de reemplazarlas, y una que declare con el mismo id gana — que es como se estrecha
					un solo agente sin estrechar el resto.
				</p>
			</section>

			<section>
				<span className="eyebrow">Empezar de nuevo</span>
				<h2>/clear tira la conversación y deja al agente en pie</h2>
				<Screen>{`
> /clear
scout has forgotten the conversation.

The repository is untouched: scout's soul, its skills and whatever it wrote down to remember
are what outlive a conversation, and are why throwing one away costs little. So is everything
/model, /mcp, /limit and /serve have set. The next thing said starts it again on nothing.
`}</Screen>
				<p>
					Lo dice cada vez, y decirlo es la mitad del comando: un clear cuyo costo nadie tiene claro
					es uno que se pospone hasta que el contexto es un desastre. Un agente que se ha metido
					hablando en un callejón sin salida rara vez es uno que valga la pena borrar, y antes de
					esto la única salida del callejón se llevaba el repositorio por delante.
				</p>
				<p className="small muted">
					Una conversación vive en tres lugares y los tres se van juntos — lo que se le muestra al
					modelo al principio del turno siguiente, la transcripción en disco que sobrevive a la
					consola, y el panel que estás leyendo. El turno en vuelo se detiene primero, y eso no es
					una cortesía: la sesión se escribe al final de un turno, así que una conversación borrada
					por debajo de una en marcha volvería tal cual, con todo dentro, un minuto después.
				</p>
			</section>

			<section>
				<span className="eyebrow">Quitar uno</span>
				<h2>Hay una sola clase de borrado y es el entero</h2>
				<Screen>{`
> /delete
Deleting scout stops its container and throws it away, along with the repository inside
it: everything it wrote, remembered and made for itself. There is no copy of that anywhere
and nothing here can put it back.

Nothing has been deleted yet.
╭──────────────────────────────────────────────────────────────────────╮
│ delete scout?  y / n                                                 │
╰──────────────────────────────────────────────────────────────────────╯
 y delete   n cancel   ^C quit
`}</Screen>
				<p>
					El contenedor, el repositorio que hay dentro y la conversación — porque un borrado que
					dejara el nombre ahí en la columna es uno que te dijeron que funcionó y tenés que volver a
					hacer. Así que pregunta primero, en el propio prompt, y la pregunta se queda con todo el
					teclado hasta que se responde: <code>y</code> borra y cualquier otra tecla se marcha,
					incluido el retorno que se presionó hace un momento para preguntarla.
				</p>
				<p>
					La pregunta vive en la consola y no en el plano, y ese es su sentido: un plano que
					aceptara <code>/delete scout</code> desde cualquier parte dejaría que una línea fuera un
					agente entero. Lo que se escriba después del comando se descarta y la forma desnuda baja
					primero, así que un comando no alcanza más allá de la conversación en la que se escribió.
				</p>
				<p className="small muted">
					Un agente que declaraste en la configuración se va igual, lo cual lleva un paso más de lo
					que parece: tu archivo es tuyo y ningún plano puede escribirlo, así que no hay de dónde
					sacar el nombre. En su lugar se anota el borrado, en <code>deleted.json</code> junto al
					estado, y cada arranque a partir de entonces salta el nombre. La respuesta lo dice, porque
					la línea sigue en tu archivo y sacarla es lo único que queda por hacer con ese agente.
				</p>
				<p className="small muted">
					En un shell, <code>squad rm scout</code> se lleva el contenedor y deja el volumen, porque
					el volumen es el agente. <code>--purge</code> borra eso también, y pide que se escriba
					antes el nombre del agente para que una <code>y</code> refleja no pueda hacerlo.
				</p>
			</section>
		</Docs>
	);
}
