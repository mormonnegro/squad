import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

const LEVELS: [string, string, string][] = [
	[
		"operator",
		"puede instruir",
		"lo escribió un operador: el socket de control, o un horario que fijó un operador",
	],
	[
		"participant",
		"datos, atribuidos",
		"un humano conocido en un canal — alguien más en el chat de Telegram",
	],
	["public", "datos", "un payload de webhook; cualquiera en internet"],
];

const WHERE: [string, string][] = [
	[
		"un webhook",
		"No puede llevar confianza de operador, por bien firmado que esté. El secreto prueba qué sistema envió la petición, nunca que un humano quisiera decir lo que hay dentro.",
	],
	[
		"Telegram",
		"Puede, y solo desde la única cuenta que pulsó el enlace de emparejamiento. Todos los demás en el chat son participantes, sea cual sea la redacción del mensaje y diga venir de quien diga.",
	],
	[
		"el correo",
		"Puede, y solo desde una dirección que se emparejó, y solo cuando el Authentication-Results del propio proveedor receptor dice que DKIM y DMARC pasaron alineados con el dominio que declara.",
	],
	[
		"un despertar",
		"Un agente puede programarse a sí mismo, pero no con confianza de operador. Si no, una inyección exitosa es permanente.",
	],
	[
		"el socket",
		"La única puerta que lleva confianza de operador. Es 0600, y alcanzarla ya significa tener en la mano un archivo del que el operador es dueño.",
	],
];

export default function Trust() {
	return (
		<Docs
			title="Confianza"
			lede="Un agente que se ejecuta sin vigilancia acabará leyendo algo que escribió un desconocido. Por eso cada evento lleva un nivel de confianza, y solo el de un operador se representa como una instrucción."
			description="Los tres niveles de confianza, dónde puede situarse cada canal, y por qué la regla se aplica en más de un sitio."
		>
			<section>
				<span className="eyebrow">Tres niveles</span>
				<h2>Solo uno de ellos puede decirle a un agente qué hacer</h2>
				<table className="table">
					<tbody>
						{LEVELS.map(([level, may, who]) => (
							<tr key={level}>
								<td>{level}</td>
								<td>
									{may} — {who}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				<p>
					Todo lo que no viene del operador llega vallado y presentado como datos, en un solo sitio,
					para que un adaptador de canal nuevo no pueda olvidarse de hacerlo. El nonce de la valla
					es aleatorio y se elige después de escribir el contenido, así que nada de dentro puede
					cerrarla.
				</p>
			</section>

			<section>
				<span className="eyebrow">Aplicada más de una vez</span>
				<h2>Porque hay más de una forma de blanquear autoridad</h2>
				<table className="table">
					<tbody>
						{WHERE.map(([what, rule]) => (
							<tr key={what}>
								<td>{what}</td>
								<td>{rule}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="small muted">
					La regla del despertar es la menos obvia y la que más peso carga. Si un agente pudiera
					programarse a sí mismo con confianza de operador, una inyección exitosa sería permanente:
					el turno inyectado programa un despertar que instruye, y el agente sigue instruyéndose a
					sí mismo sin ningún atacante presente al que notar o revocar.{" "}
					<Link href="/es/docs/schedules/">Horarios</Link> es el resto de eso.
				</p>
			</section>

			<section>
				<span className="eyebrow">Y es visible</span>
				<h2>Todo lo que no se teclea en la consola lleva una marca</h2>
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
					El panel se relee para averiguar quién pidió qué, y una línea de un desconocido dibujada
					igual que la del operador es el único fallo que importa en una ventana de chat. Solo lo
					que llega por el socket de control se dibuja como el operador; todo lo demás lleva el
					nombre del canal por el que entró, tu propio correo incluido.
				</p>
			</section>

			<section>
				<span className="eyebrow">Lo que no pretende</span>
				<h2>La frontera es el sandbox, y los secretos</h2>
				<p>
					El plano de control tiene el socket de Docker, así que es equivalente a root en la
					máquina: la frontera de confianza es el sandbox alrededor del agente, no el proceso que lo
					gestiona. Y un agente que puede ejecutar código en un sandbox y alcanzar internet puede
					enviar lo que leyó a algún sitio que vos no elegiste — eso vale para{" "}
					<Link href="/es/docs/grants/">
						cualquier concesión lo bastante amplia como para ser útil
					</Link>
					, y es por lo que la frontera que pesa es la que rodea las credenciales y no la que rodea
					las direcciones.
				</p>
				<p className="small muted">
					Un contenedor por agente, no una microVM — porque si autoalojarlo necesitara microVMs
					nadie lo ejecutaría. No es una frontera dentro de la que meter código hostil.
				</p>
			</section>
		</Docs>
	);
}
