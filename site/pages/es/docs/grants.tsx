import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Grants() {
	return (
		<Docs
			title="Alcance"
			lede="Sobre cada petición se hacen dos preguntas, y el error es responderlas juntas. Lo que un agente puede alcanzar y de quién es la credencial que va con ella tienen radios de explosión muy distintos."
			description="El proxy de egress, las concesiones que responden adónde puede ir un agente, y las credenciales que nunca tiene."
		>
			<section>
				<span className="eyebrow">El camino está abierto</span>
				<h2>Porque un registro nunca es un solo host</h2>
				<Code label="deploy/config.yaml">{`
defaults:
  grants:
    - id: web
      host: "*"
      injection:
        kind: none
`}</Code>
				<p>
					A un agente al que se le pide una página hello-world le hace falta{" "}
					<code>npm install</code> antes que ninguna otra cosa, y un registro nunca es un solo host
					— npm es un registro y una CDN, PyPI es un índice y un servidor de archivos, un{" "}
					<code>git clone</code> son tres nombres antes de ser un checkout. Una lista de ellos es
					una lista equivocada por uno, y equivocada por uno es peor que cualquiera de los dos
					extremos: parece que funciona hasta la tarde en que no, y lo que el agente hace entonces
					no es levantar la mano. Lee la denegación como que internet se ha caído y escribe la
					página que le pidieron como un párrafo sobre no poder escribirla.
				</p>
				<p>
					Toda petición sigue cruzando el proxy, sigue siendo cotejada, y sigue cayendo en el
					registro de auditoría con el host y la ruta a la que fue. Borra la concesión{" "}
					<code>web</code> y el plano vuelve a denegar por defecto, host por host, exactamente como
					estaba.
				</p>
			</section>

			<section>
				<span className="eyebrow">Las claves no lo están</span>
				<h2>kind: none es toda la razón por la que esa línea es segura de escribir</h2>
				<p>
					Nada tuyo se adjunta a nada que se alcance por la concesión abierta. Una concesión sobre{" "}
					<code>*</code> que llevara una credencial pondría ese secreto en todos los servidores que
					el agente alcanza, así que se rechaza donde se lee la configuración en vez de descubrirse
					más tarde:
				</p>
				<Screen>{`
Invalid configuration:
  - defaults.grants[0] is host "*" with a bearer credential, which would put that secret on
    every server the agent reaches. Name the host, or use injection: { kind: none }
`}</Screen>
				<p>
					Un host con nombre siempre gana la petición frente al abierto, así que la clave del modelo
					va al modelo y a ningún otro sitio. El token se escribe sobre la petición una vez que ha
					coincidido, de salida — el agente nunca lo tiene, y a un agente al que convenzan de
					publicar su entorno en algún sitio no le queda nada que publicar.
				</p>
				<Code label="deploy/config.yaml">{`
agents:
  - id: scout
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
					<code>ref</code> nombra una variable del entorno del propio plano de control, nunca un
					valor. El bloque propio de un agente se suma a los defaults en lugar de reemplazarlos, y
					una concesión que declare con el mismo id gana — que es como se estrecha un agente sin
					estrechar el resto.
				</p>
			</section>

			<section>
				<span className="eyebrow">Añadir un host</span>
				<h2>El rechazo llega en un turno, y la respuesta no debería ser un despliegue</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ An agent has no route out of its own: the sandbox sits on a    │
│ network with nowhere to go, and every request it makes is one  │
│ the proxy was told beforehand to allow. A host that is not on  │
│ this list is a connection refused.                             │
│                                                                │
│ A host opened here carries nothing. Keys are attached by name, │
│ in deploy/config.yaml, and that is the half of a grant this    │
│ screen has no box for — so what is added here widens where an  │
│ agent may go and not one thing about what it may spend.        │
│                                                                │
│ ● api.anthropic.com                       with a model         │
│ ● api.openai.com     /v1/responses  POST  for searching        │
│ ● api.github.com                          from the file        │
│ ● api.chess.com                           opened here          │
│ + a host                                                       │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ carries nothing   opened here   ⌫ closes it                │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<p>
					Host por host es una buena manera de llevar esto, y deja de serlo en cuanto añadir un host
					exige editar un archivo en el servidor y volver a levantar el plano. Lo que eso cuesta no
					es el minuto: es que el rechazo llega en el turno de un agente, horas después de la última
					vez que se pensó en el archivo.
				</p>
				<p>
					Una casilla y una palabra — <code>api.chess.com</code>, o la URL entera que estabas
					mirando cuando ocurrió el rechazo, ya que el host se lee de ella. Lo que una persona tiene
					a mano en ese momento es la dirección del error y no el host que hay en ella. No hay campo
					para una ruta, un método, un id o una clave. Lo último es el punto: esta pantalla escribe{" "}
					<code>injection: {"{ kind: none }"}</code> y no tiene dónde expresar otra cosa, así que la
					consola puede ampliar adónde va un agente y nunca puede decidir lo que gasta. Esa mitad se
					queda en el archivo, y por eso las filas que vinieron de él rechazan <code>⌫</code> y
					dicen en qué lista cambiarlas.
				</p>
				<p className="small muted">
					Una concesión que dedujo el plano está marcada con lo que la dedujo —{" "}
					<code>with a model</code>, <code>for searching</code> — porque un host del que no puedes
					dar cuenta es uno que nadie se atreve a cerrar.{" "}
					<Link href="/es/docs/models/">Modelos</Link> y{" "}
					<Link href="/es/docs/search/">búsqueda web</Link> son de donde vienen esos dos.
				</p>
			</section>

			<section>
				<span className="eyebrow">Lo que no pretende</span>
				<h2>El límite que sostiene el peso es el que rodea los secretos</h2>
				<p>
					Un agente que puede ejecutar código en un sandbox y alcanzar internet puede mandar lo que
					leyó a algún sitio que no elegiste. Eso ya era cierto de cualquier concesión lo bastante
					amplia para ser útil, y es la razón por la que lo que se mantiene lejos de él es la
					credencial y no la dirección. Un agente robado obtiene el alcance que tenía; no obtiene tu
					cuenta. <Link href="/es/docs/trust/">Confianza</Link> es el resto de eso.
				</p>
			</section>
		</Docs>
	);
}
