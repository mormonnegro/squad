import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Limits() {
	return (
		<Docs
			title="Gasto"
			lede="Un agente que reserva su propio turno siguiente es uno que sigue ejecutándose sin que nadie mire, y hasta que hay un techo lo primero que se sabe de un bucle es la factura."
			description="Dólares al día por agente, dónde se fija el techo, qué pasa al llegar a él, y por qué este es el único ajuste que el teclado puede bajar."
		>
			<section>
				<span className="eyebrow">El techo</span>
				<h2>Dólares al día, y un día que pertenece al plano</h2>
				<Code label="deploy/config.yaml">{`
defaults:
  limitUsd: 5
`}</Code>
				<p>
					Dólares estadounidenses al día, contados a lo largo de cada turno y reiniciados a
					medianoche UTC — la medianoche del plano, ya que una de las dos máquinas tiene que decidir
					cuándo pasa el día y es el plano el que lo aplica. En <code>defaults</code> cubre también
					a los agentes creados después con el teclado, que son exactamente aquellos a los que nadie
					se acuerda de ponerles un techo; el bloque propio de un agente lo estrecha, y omitirlo es
					no tener techo alguno.
				</p>
				<p className="small muted">
					Lo que costó un turno se informaba en el feed desde siempre y no se sumaba en ninguna
					parte, que es lo mismo que no saberlo.
				</p>
			</section>

			<section>
				<span className="eyebrow">Llegar a él</span>
				<h2>Detiene que el agente tome turnos, no un turno en vuelo</h2>
				<p>
					El objetivo no es matar trabajo a medias, que ya está pagado, sino no empezar más. No se
					pierde nada: los mensajes que llegan mientras está por encima del techo están en la
					conversación, anotados cuando llegaron, y el plano dice ahí por qué no responde. Eso
					importa más de lo que parece, porque un plano que deja de responder en silencio es
					indistinguible de uno roto. Al día siguiente continúa.
				</p>
			</section>

			<section>
				<span className="eyebrow">Moverlo</span>
				<h2>/limit, y ambas mitades en la conversación</h2>
				<Screen>{`
> /limit
$0.42 spent today, against no limit.
> /limit 5
Spending limit set to $5.00 a day. $0.42 spent today, of $5.00 a day.
`}</Screen>
				<p>
					<code>/limit</code> lo mueve para un agente sin editar el archivo. Ambas mitades van a la
					conversación, porque es ahí donde se teclearon y donde se lee la respuesta: un techo que
					cambió sin nada que lo muestre es uno cuya razón nadie puede averiguar después.
				</p>
				<p>
					<code>/limit off</code> significa sin techo y no "olvida lo que dije" — el valor del
					archivo de configuración no vuelve, ya que reinstaurar el techo que alguien estaba en el
					acto de quitar es una sorpresa de la que se enterarían al chocar con ella.
				</p>
			</section>

			<section>
				<span className="eyebrow">Dónde se ve</span>
				<h2>En la fila, antes de que sea una pregunta que alguien haga</h2>
				<Screen>{`
│ agents               │
│                      │
│ ● demo         $4.10 │
│ ○ scout              │
│                      │
│ + new agent          │
`}</Screen>
				<p>
					Lo que cada agente ha gastado hoy está en su fila, porque "cuál de estos se está quemando
					el día" es una pregunta sobre todos a la vez y la cabecera solo puede responderla sobre
					aquel en el que estás parado. La cifra se pone amarilla a cuatro quintos del techo y roja
					al llegar. Un agente que no ha gastado nada no dice nada — una columna de{" "}
					<code>$0.00</code> es ruido que hay que saltarse al leer, y lo que se busca aquí es la
					fila que no es como las demás.
				</p>
				<p className="small muted">
					La fila de título dice con qué está pensando el agente seleccionado y cuánto ha costado
					eso frente a lo que tiene permitido. Ambas cosas ya cruzaban el socket y se tiraban, y el
					precio de eso era que la forma de averiguar con qué modelo respondía mal un agente era ir
					a leer el archivo de configuración del operador.
				</p>
			</section>

			<section>
				<span className="eyebrow">Por qué un agente puede pedirlo</span>
				<h2>Sujeto a menos, nunca a más</h2>
				<Screen>{`
‹ask› /limit 50
This agent asked for a ceiling of $50.00 a day, which is above the $5.00 it has. It can ask to
be held to less, never to more: /limit $50.00, if you meant it.
`}</Screen>
				<p>
					Un techo es el único ajuste que el teclado puede tocar, y es seguro por la razón por la
					que una concesión no lo es: solo puede quitar capacidad. Así que un agente puede pedir que
					se le sujete a uno más estrecho y no llega a ninguna parte pidiendo uno más holgado — y la
					negativa le entrega al operador la línea que habría tecleado, en el momento en que es la
					respuesta, en el panel que ya estaba mirando.{" "}
					<Link href="/es/docs/console/">La consola</Link> tiene el resto de lo que un agente puede
					pedir.
				</p>
			</section>
		</Docs>
	);
}
