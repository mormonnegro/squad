import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

const SECTIONS: [string, string][] = [
	["models", "los proveedores que este plano puede pagar, y con qué piensan sus agentes"],
	["search", "adónde va web_search, y cuánto cuesta una búsqueda"],
	["grants", "los hosts que los agentes pueden alcanzar, y qué llevan"],
	["mcp", "los servidores del estante, y qué agentes los tienen"],
	["email", "el buzón en el que se llega a los agentes, y de quién leen el correo"],
];

export default function Config() {
	return (
		<Docs
			title="config.yaml"
			lede="Toda capacidad que tiene un agente está en un archivo, y ningún secreto lo está. El archivo que describe lo que un agente puede alcanzar debería caber en un commit y leerse en un diff, porque una concesión que nadie vio añadirse es el modo de fallo."
			description="Toda la superficie de configuración, lo que deliberadamente no contiene, y el almacén de al lado en el que escribe la consola."
		>
			<section>
				<span className="eyebrow">La superficie</span>
				<h2>Cinco claves, y nada que no quisieras en un diff</h2>
				<Code label="deploy/config.yaml">{`
stateDir: /var/lib/squad

models:                   # con qué hay para pensar
defaults:                 # model, limitUsd, grants — y todo lo de un agente creado después
agents:                   # id, description, grants, schedules
hooks:                    # los endpoints firmados, y a qué agente llega cada uno
`}</Code>
				<p>
					<code>deploy/config.example.yaml</code> es esa superficie escrita entera con las razones
					al lado. No hay ningún secreto en nada de ello: nombra variables de entorno y el proceso
					guarda los valores, así que el archivo va a git y revisarlo es revisar lo que pueden hacer
					los agentes.
				</p>
				<p className="small muted">
					<code>defaults</code> es la respuesta del operador, dada de antemano, a lo que puede
					alcanzar un agente creado desde el teclado — porque nada de lo que se le diga a un agente
					en un panel de chat puede ampliarlo. El bloque propio de un agente se suma a esos en lugar
					de reemplazarlos.
				</p>
			</section>

			<section>
				<span className="eyebrow">La pantalla de al lado</span>
				<h2>Todo lo que se le puede dar a este plano, en un solo sitio</h2>
				<Screen>{`
│ config                                                         │
│                                                                │
│ Everything this plane can be given is here: the keys it pays   │
│ with, what its agents think with, where they search from,      │
│ everywhere they may reach, and the mailbox they are written    │
│ to at.                                                         │
│                                                                │
│ All of it is kept beside deploy/config.yaml rather than in it  │
│ — what that file declares is read here and changed only there  │
│ — and all of it holds from the next turn, with nothing         │
│ restarted.                                                     │
│                                                                │
│ ● models    the providers this plane can pay, and what its ag… │
│ ○ search    where web_search goes, and what a search costs     │
│ ● grants    the hosts the agents may reach, and what they car… │
│ ● mcp       the servers on the shelf, and which agents hold t… │
│ ○ email     the mailbox agents are reached at, and whose mai… │
│ ╭────────────────────────────────────────────────────────────╮ │
│ │ 3 to think with, 1 of 4 providers paid for                 │ │
│ ╰────────────────────────────────────────────────────────────╯ │
`}</Screen>
				<table className="table">
					<tbody>
						{SECTIONS.map(([name, what]) => (
							<tr key={name}>
								<td>{name}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p>
					Cada fila dice para qué sirve su sección, porque una columna de sustantivos secos es una
					pantalla en la que hay que abrir todas las filas para encontrar aquella por la que
					viniste. La línea bajo la lista es cómo está esa sección de verdad —{" "}
					<code>1 of 4 providers paid for</code>, la dirección a la que llega el correo — que es el
					hecho que no puede llevar una fila que dice para qué sirve, y suele ser la razón por la
					que estás aquí.
				</p>
				<p>
					Hay dos maneras de entrar. La columna es una — la pantalla es su última fila, así que{" "}
					<code>shift-tab</code> desde el primer agente llega en una sola pulsación — y{" "}
					<code>/config</code> es la otra, tecleada desde donde ya está la mano.{" "}
					<code>/config email</code> se salta esta lista y aterriza en esa sección.
				</p>
			</section>

			<section>
				<span className="eyebrow">Cuál de los dos gana</span>
				<h2>Lo que declara el archivo se lee aquí y se cambia solo allí</h2>
				<p>
					Todo lo que se da en la consola vive en un almacén junto a <code>config.yaml</code> y
					nunca dentro de él, así que el archivo del operador sigue siendo del operador. Un
					redespliegue trae de vuelta lo que se escribió allí, y lo que se tecleó aquí sobrevive al
					redespliegue por su cuenta. <code>from the file</code> es una fila que la pantalla no va a
					tapar y no va a quitar, y lo dice en vez de negarse después.
				</p>
				<p>
					Una edición del archivo mismo se lee cuando arranca el plano, así que toma efecto con{" "}
					<code>docker compose restart control-plane</code> desde <code>/opt/squad/deploy</code>.
					Ese es el camino para la mitad para la que la consola no tiene casilla — la credencial de
					una concesión — y es la razón por la que la consola puede ampliar adónde va un agente y
					nunca puede decidir lo que gasta. <Link href="/es/docs/grants/">Alcance</Link> es donde se
					traza esa línea.
				</p>
			</section>

			<section>
				<span className="eyebrow">El despliegue</span>
				<h2>Tres cosas que sostienen el peso y son fáciles de equivocar</h2>
				<p>
					El plano de control corre <strong>en la red de los agentes</strong>, no en el host. Los
					contenedores de una red interna no pueden alcanzar el host en absoluto, así que un proxy
					en el host es uno que los agentes no pueden usar.
				</p>
				<p>
					El directorio de estado se monta por bind <strong>en su propia ruta</strong>. El plano de
					control le pasa al daemon esa ruta al montar la CA dentro de un sandbox, y el daemon
					resuelve los orígenes del bind en el host.
				</p>
				<p>
					Un sandbox <strong>sobrevive al plano que lo creó</strong>, y su credencial de proxy está
					en su entorno — así que un plano que rearranca vuelve a leer esa credencial del contenedor
					en vez de decidirla. Un plano que la decidiera volvería denegando toda petición que
					hicieran sus propios agentes, el modelo incluido, con los sandboxes pareciendo
					perfectamente sanos.
				</p>
				<p className="small muted">
					El plano de control tiene el socket de Docker, así que equivale a root en la máquina. El
					límite de confianza es el sandbox alrededor del agente, no el proceso que lo gestiona —{" "}
					<Link href="/es/docs/trust/">Confianza</Link> dice qué afirma eso y qué no.
				</p>
			</section>
		</Docs>
	);
}
