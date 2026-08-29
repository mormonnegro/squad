import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";
import { DOC_PAGES, DOCS } from "../../../lib/docs";
import { inLang, useLang } from "../../../lib/lang";
import { CLIENT, PI, SITE } from "../../../lib/site";

const WHERE: [string, string][] = [
	[
		"la consola",
		"Un comando de barra o la pantalla de configuración. Claves, modelos, hosts, servidores MCP, el buzón y un techo, todo vigente desde el turno siguiente y sin nada reiniciado.",
	],
	[
		"config.yaml",
		"El archivo del operador, en la máquina donde está el plano, que ningún plano puede escribir: agentes, horarios, webhooks, y cada credencial atada por nombre a un host.",
	],
	[
		"el repositorio",
		"Dentro del volumen propio del agente: quién es, qué recuerda, las habilidades que cargó y las herramientas que se escribió. Suyo para editarlo, y de nada más.",
	],
];

export default function DocsIndex() {
	const { lang } = useLang();
	return (
		<Docs
			title="Resumen"
			lede="Un agente aquí es un contenedor que sigue en marcha, se despierta cuando pasa algo, y alcanza el mundo exterior solo a través de credenciales que nunca ve."
			description="Qué es squad, de qué está hecho un agente, y dónde vive cada ajuste: la consola, el archivo de configuración y el repositorio propio del agente."
		>
			<section>
				<span className="eyebrow">La forma que tiene</span>
				<h2>Dos mitades, y una pregunta entre ellas</h2>
				<p>
					Está la consola en la que tecleas, y el plano en el que viven los agentes. La consola se
					instala en el equipo ante el que estás sentado, y la primera ejecución hace la única
					pregunta en la que las mitades difieren: si los agentes deben vivir <strong>aquí</strong>,
					o <strong>en un servidor</strong> al que tengas SSH.
				</p>
				<Code label="en tu equipo" wrap>{`
$ curl -fsSL ${CLIENT} | sh
$ squad
`}</Code>
				<p className="small muted">
					Node 22.18 o más nuevo, y nada más en este equipo — nada de Docker aquí, sea cual sea la
					respuesta que des. <Link href="/es/install">La página de instalación</Link> es la versión
					larga, incluida la misma cosa hecha a mano.
				</p>
				<p>
					Todo lo que viene después de esa pregunta es el mismo programa. Un plano responde al mismo
					protocolo tanto si su socket está en un directorio de aquí como si está al otro extremo de{" "}
					<code>ssh vps squad relay</code>, así que la lista de agentes, el feed de logs, la
					conversación y un puerto reenviado desde un sandbox corren todos en este equipo y llegan a
					los agentes estén donde estén.
				</p>
				<p className="small muted">
					Es un runtime más que un harness. El pensar lo hace <a href={PI}>pi</a>; squad le da una
					máquina en la que vivir, una manera de ser despertado, y un límite dentro del que
					trabajar.
				</p>
			</section>

			<section>
				<span className="eyebrow">Los primeros cinco minutos</span>
				<h2>Escribe su nombre, y crea uno</h2>
				<p>
					<code>squad</code> sin nada detrás abre la consola, porque quien teclea el comando sin
					nada detrás está pidiendo ver la cosa y no que le cuenten un hecho sobre ella. Sin ningún
					agente se abre en la única fila que hay:
				</p>
				<Screen>{`
╭──────────────────────╮╭────────────────────────────────────────────────────────────────╮
│ agents               ││ new agent                                                      │
│                      ││                                                                │
│ + new agent          ││ A name, and ⏎ builds it: a container, a repository of its own, │
│                      ││ nothing in its memory, and exactly what defaults in the config │
│ logs                 ││ allows it to reach.                                            │
│ config               ││                                                                │
│                      ││ ╭────────────────────────────────────────────────────────────╮ │
│ ↑↓ moves             ││ │ name  scout                                                │ │
╰──────────────────────╯╰────────────────────────────────────────────────────────────────╯
 ↑↓ agents   ⏎ build   ^C quit
`}</Screen>
				<p>
					El nombre es todo lo que decide el teclado ahí. Lo que el agente nuevo puede alcanzar es{" "}
					<code>defaults</code> en la configuración, respondido de antemano por quien escribió ese
					archivo — porque lo único que un teclado nunca puede hacer aquí es conceder. Luego hablas
					con él, y toma un turno.
				</p>
				<p className="small muted">
					<Link href="/es/docs/console/">La consola</Link> es todas las teclas y todos los comandos
					de esa pantalla. <Link href="/es/docs/agents/">Agentes</Link> es de qué acaba estando
					hecho uno.
				</p>
			</section>

			<section>
				<span className="eyebrow">Antes de ponerte a buscar</span>
				<h2>Tres sitios donde vive un ajuste</h2>
				<p>
					Casi toda pregunta que empieza por «dónde pongo…» se responde con a cuál de estos tres
					pertenece, y se distinguen por quién puede escribirlos.
				</p>
				<table className="table">
					<tbody>
						{WHERE.map(([where, what]) => (
							<tr key={where}>
								<td>{where}</td>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					La consola guarda lo que se le da en un almacén junto a <code>config.yaml</code> y nunca
					dentro de él, así que el archivo del operador sigue siendo del operador: lo que trae de
					vuelta un redespliegue es lo que se escribió allí, y lo que se tecleó en la consola
					sobrevive al redespliegue por su cuenta.
				</p>
			</section>

			<section>
				<span className="eyebrow">Todo lo que hay</span>
				<h2>El mapa</h2>
				{DOCS.map((group) => (
					<div className="docs-map" key={group.name.en}>
						<h3>{group.name[lang]}</h3>
						<table className="table">
							<tbody>
								{group.pages.map((page) => (
									<tr key={page.href}>
										<td>
											<Link href={inLang(page.href, lang)}>{page.title[lang]}</Link>
										</td>
										<td>{page.blurb[lang]}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				))}
			</section>

			<section>
				<span className="eyebrow">Leer esto sin un navegador</span>
				<h2>Una sola dirección le entrega a un agente todo esto</h2>
				<p>
					Cada página de aquí está escrita también como markdown en la misma dirección con{" "}
					<code>.md</code> al final, y las {DOC_PAGES.length} están en un solo archivo. Ese archivo
					es lo que hay que pegar cuando a quien le estás explicando squad es un agente de código y
					no una persona:
				</p>
				<Code label="toda la documentación" wrap>{`
${SITE}/llms-full.txt
`}</Code>
				<p className="small muted">
					<a href="/llms.txt">/llms.txt</a> es en cambio el índice — la misma lista que el mapa de
					arriba, con un enlace al markdown de cada página, para un lector que prefiera traerse la
					única página que necesita. Los dos se convierten de estas páginas en el build en vez de
					escribirse al lado, así que ninguno puede ir una versión por detrás de lo que estás
					leyendo ahora.
				</p>
			</section>
		</Docs>
	);
}
