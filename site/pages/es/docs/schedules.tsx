import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Schedules() {
	return (
		<Docs
			title="Horarios"
			lede="Un trabajo permanente que escribiste vos, y un turno que el agente reserva para sí mismo. Uno de los dos puede instruir, y es el que escribiste vos."
			description="Horarios cron en el archivo de configuración, y wake_me: cómo un agente pide otro turno, qué puede dejarse a sí mismo, y por qué ese despertar nunca lleva confianza de operador."
		>
			<section>
				<span className="eyebrow">El que escribiste vos</span>
				<h2>Cron, en el bloque propio del agente</h2>
				<Code label="deploy/config.yaml">{`
schedules:
  - kind: cron
    expression: "0 9 * * 1-5"
    timeZone: America/Argentina/Buenos_Aires
    channel: cron:standup
    body: Summarise yesterday's issues and post the standup note.
    # Un operador escribió esta línea, así que el despertar puede instruir.
    trust: operator
    createdBy: operator
`}</Code>
				<p>
					Semántica de Vixie cron, cotejada con el reloj de pared en la zona que nombres, de modo
					que un trabajo a las nueve de la mañana es a las nueve de la mañana a ambos lados de un
					cambio de horario de verano y no a las ocho durante medio año. Los despertares de una sola
					vez son el otro tipo, y ambos se persisten — un plano que se reinicia vuelve debiendo las
					mismas citas.
				</p>
				<p className="small muted">
					<code>trust: operator</code> se permite acá y en ningún otro sitio al que un agente pueda
					llegar, porque una línea en este archivo es algo que tecleó un operador. Eso es lo que
					hace que un horario pueda decir <em>hacé esto</em> en vez de <em>alguien dijo esto</em>.
				</p>
			</section>

			<section>
				<span className="eyebrow">El que reserva él</span>
				<h2>wake_me pide otro turno y se deja una nota</h2>
				<Screen>{`
00:12:36  demo      wake_me     {"afterSeconds":180,"note":"Check whether example.com is still up.
                                First check: HTTP 200 at 00:12."}
00:15:38  demo      bash        curl -sS -o /dev/null -w "HTTP %{http_code}" -m 15 https://example.com
`}</Screen>
				<p>
					El trabajo que no termina de una sentada acababa antes con el turno. <code>wake_me</code>{" "}
					es una extensión de pi que viene en la imagen del sandbox, así que es del plano arreglarla
					y no del agente editarla. La espera se ve junto al agente en la consola —{" "}
					<code>● demo 3m</code> — porque un agente a punto de actuar sin que nadie mire no debería
					necesitar un comando para notarlo.
				</p>
				<p>
					No hay camino del sandbox al plano, y esto no abre ninguno: la petición es un archivo que
					el agente escribe, que el plano lee y borra una vez terminado el turno. Así que el plano
					lo comprueba en vez de confiar en él. Hay un despertar pendiente a la vez, así que volver
					a pedirlo mueve la cita en vez de sumarse a ella; la demora se mantiene entre un segundo y
					un mes; y el despertar lleva <Link href="/es/docs/trust/">confianza de participante</Link>
					, nunca de operador, lo pida como lo pida.
				</p>
				<p className="small muted">
					Cancelarlo es una segunda herramienta, <code>cancel_wake</code>, y no un tiempo que
					signifique nunca — el recorte es justo la razón por la que no existe tal tiempo, así que
					un agente que empuja su despertar a un año vista para quitárselo de encima solo lo ha
					movido un mes, y se ha quedado creyendo lo contrario.
				</p>
			</section>

			<section>
				<span className="eyebrow">Adónde va la respuesta</span>
				<h2>Un despertar responde donde está la conversación</h2>
				<p>
					Pedí por correo un chiste cada minuto y el segundo chiste llega por correo como el
					primero: la cita lleva el canal al que respondía el turno que la reservó, y también lo
					lleva la cita que ese turno reserva después. Un despertar respondía antes al propio
					agente, y por eso el primer chiste llegó y el resto se escribieron, se pagaron y no se le
					dijeron a nadie.
				</p>
				<p>
					Un despertar que vence mientras alguien escribe se pliega dentro del mismo turno, y ahí la
					conversación gana el empate: un agente que en su lugar reservara sobre su propia nota no
					tendría delante más que sus propias notas para siempre, y reservaría la siguiente igual.
				</p>
				<p className="small muted">
					Un turno reserva su despertar una vez. La segunda petición en el mismo turno se rechaza,
					porque no es un agente cambiando de idea sobre cuándo — es un agente que leyó{" "}
					<em>se te despertará a las 09:41</em> como que la espera había terminado. A uno al que se
					le pidió un chiste por minuto le salieron doscientos en un solo turno de esa manera, con
					tres segundos de diferencia. Cambiar de idea es <code>cancel_wake</code> y luego volver a
					pedirlo, lo que dice en voz alta que la cita ya no está.
				</p>
				<p className="small muted">
					Cancelarlo tira lo que la cita ya ha producido además de la cita — un despertar de diez
					segundos salta mientras corre un turno de dos minutos y se pone en cola detrás de él. Solo
					se van sus propias reservas: a un mensaje que alguien tecleó a un agente ocupado se le
					debe una respuesta decidiera lo que decidiera el agente mientras estaba en la cola.
				</p>
			</section>
		</Docs>
	);
}
