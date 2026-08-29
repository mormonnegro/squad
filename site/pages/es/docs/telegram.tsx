import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Telegram() {
	return (
		<Docs
			title="Telegram"
			lede="Un bot por agente, conectado con un solo comando y emparejado con vos por una frase. Desde un teléfono, sin una dirección pública, un certificado ni un puerto abierto — porque el bot sale hacia Telegram y no al revés."
			description="Conectar un bot de Telegram a un agente: crearlo con BotFather, pegar el token, emparejarte con el enlace o la frase y saber a quién más se escucha en el chat."
		>
			<section>
				<span className="eyebrow">Dos pasos</span>
				<h2>Creá un bot, y pegá de vuelta lo que BotFather te dé</h2>
				<p>
					Enviá <code>/newbot</code> a <a href="https://t.me/BotFather">@BotFather</a>, respondé las
					dos preguntas que hace y te entrega un token. Ese token va a la consola, en el prompt del
					agente que querés que sea:
				</p>
				<Screen>{`
/telegram 8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw

@nightly_scout_bot is scout's bot.

Nobody is paired to it yet. Open this and press Start, and it is yours:
https://t.me/nightly_scout_bot?start=kqm3nvbh27

If pressing Start does nothing — which happens on Telegram Web — write to @nightly_scout_bot
and send it this phrase instead:

    kqm3nvbh27

Whoever does either is the one scout takes instructions from. Anyone else who writes to it is
heard, and what they write arrives as something to consider rather than something to do.
`}</Screen>
				<p>
					El enlace es la vía corta y no la única, porque Telegram Web abre el chat sin entregarle
					al bot lo que va detrás de <code>?start=</code> — pulsar Start ahí no empareja nada y te
					deja en un chat vacío sin nada que escribir. Así que la frase se da también por separado,
					y empareja en cualquier mensaje, en las mayúsculas o minúsculas que el teclado haya
					decidido enviar.
				</p>
			</section>

			<section>
				<span className="eyebrow">A quién se escucha, y a quién se obedece</span>
				<h2>El emparejamiento es una frase, y se gasta en el momento en que se usa</h2>
				<p>
					Eso es lo que hace de Telegram el primer canal que puede llevar confianza de operador. El
					secreto de un webhook prueba qué sistema envió una petición; Telegram autentica la cuenta
					detrás de cada mensaje, así que el plano puede saber que quien escribe es quien emparejó.
				</p>
				<p>
					El bot responde en el chat en el que emparejaste, y en cualquier chat en el que le hables
					después; todo lo demás se descarta sin leer. Todos los demás en esos chats son{" "}
					<Link href="/es/docs/trust/">participantes</Link>, vallados como cualquier otro
					desconocido — lo que escriben llega como datos con un nombre encima y no como una
					instrucción, esté redactado como esté y diga venir de quien diga.
				</p>
				<p className="small muted">
					Los mensajes se pliegan en un turno igual que los de un webhook: un agente al que se
					escribe cinco veces mientras está ocupado toma un turno sobre cinco cosas en vez de cinco
					turnos que hayan visto cada uno un quinto de ello. La respuesta vuelve al chat desde el
					que se despertó el turno.
				</p>
			</section>

			<section>
				<span className="eyebrow">Después</span>
				<h2>Cómo está la cosa, y darlo de baja</h2>
				<p>
					<code>/telegram</code> a secas dice en qué bot responde este agente y si hay alguien
					emparejado con él. <code>/telegram off</code> da de baja al bot — el token sigue siendo
					tuyo en BotFather, y volver a conectarlo empieza el emparejamiento de nuevo.
				</p>
				<p>
					El token es la cuenta entera, así que nunca se escribe en <code>config.yaml</code> ni se
					deja en la transcripción: lo que la consola registra es{" "}
					<code>/telegram 8123456789:…</code>, conservando la mitad pública que dice qué bot era.
				</p>
				<div className="note warn">
					<p>
						<strong>Un agente no puede ejecutar esto, en ninguna de las dos direcciones.</strong> Es
						el único comando en el que pedirlo ya es el ataque: un agente capaz de conectar un bot
						que encontrara y repartir la frase de emparejamiento se habría nombrado operador a sí
						mismo. La negativa no devuelve la línea en eco, porque imprimirla sería dejar la
						credencial a un pegado de distancia.
					</p>
				</div>
			</section>
		</Docs>
	);
}
