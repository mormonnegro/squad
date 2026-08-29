import Link from "next/link";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Email() {
	return (
		<Docs
			title="Correo"
			lede="Un buzón para todo el plano, conectado una vez. A cada agente que tenés — y a cada agente que hagas después de esto — se le alcanza en la misma dirección con su propio nombre puesto como etiqueta."
			description="Conectá un buzón al plano: escribí la dirección, creá una contraseña de aplicación, emparejate mediante una frase, y enumerá quién más puede escribir — una dirección a la vez o un dominio entero."
		>
			<section>
				<span className="eyebrow">Por qué un buzón que ya leés</span>
				<h2>Nada que comprar, ni dominio, ni DNS, ni puerto abierto</h2>
				<p>
					El plano inicia sesión y lo lee como lo hace un cliente de correo. Telegram es un bot por
					agente; el correo es todo el plano de una vez, y por eso se conecta una sola vez y cubre a
					los agentes que aún no existen.
				</p>
				<p>Escribí la dirección. Solo la dirección:</p>
				<Screen>{`
/email agents@fastmail.com

imap.fastmail.com:993 reads agents@fastmail.com and smtp.fastmail.com:465 sends from it.
One app password does both.

Now make an app password. Your ordinary password will not work, and is not the kind of
thing to paste into a console:

    https://app.fastmail.com/settings/security/apppasswords

Then paste it back:

    /email <the app password>
`}</Screen>
				<p>
					El enlace es lo importante. Cada proveedor entierra esa pantalla en un lugar distinto y
					ninguno la llama igual, así que "creá una contraseña de aplicación" es una instrucción que
					termina en un cuadro de búsqueda — que es la parte más larga de conectar un buzón y la
					parte en la que la gente se rinde.
				</p>
				<p className="small muted">
					Dónde vive el buzón se deduce de la dirección mediante autoconfig,{" "}
					<code>.well-known</code>, la ISPDB y SRV antes de recurrir a la conjetura convencional, y
					cuando es una conjetura la respuesta lo dice en vez de afirmarlo. Los dos servidores se
					nombran en una línea porque la pregunta que plantea un paso de contraseña es cuántas
					credenciales va a costar esto: es una, ya que un proveedor emite una contraseña de
					aplicación para la cuenta y no para un protocolo.
				</p>
				<div className="note warn">
					<p>
						<strong>Tres proveedores no harán esto en absoluto</strong>, y cada uno se nombra en el
						momento en que se escribe la dirección y no después de que falle un inicio de sesión.
						Microsoft retiró de plano los inicios de sesión con contraseña para IMAP. Google cerró
						Workspace a las contraseñas de aplicación en mayo de 2025 mientras que una{" "}
						<code>@gmail.com</code> personal todavía acepta una — nada en la dirección dice cuál de
						las dos es un dominio de empresa, así que se consulta el MX. El autoconfig de Proton
						anuncia honestamente <code>127.0.0.1:1143</code>, porque el correo solo es alcanzable a
						través de un bridge en tu propio escritorio.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">La segunda línea</span>
				<h2>Pegá la contraseña, y luego emparejate</h2>
				<Screen>{`
/email abcd efgh ijkl mnop

scout is reached at agents+scout@fastmail.com.

Nobody may instruct scout by mail yet. Write to that address from wherever you read your own
mail, with this phrase anywhere in the message:

    kqm3nvbh27

Ask for something in that same mail if you like. scout reads whatever the phrase was written
around, so the first mail takes a turn like any other.

Whoever sends it is the one scout takes instructions from: an address strangers already have is
one where every message read would spend a turn, so everyone else's mail is left unread.

/email allow <address> is the other way onto that list, for anyone you would rather not wait
on — and /email allow *@company.com lets a whole domain in at once.
`}</Screen>
				<p>
					Lo que hace que la frase signifique algo es que una línea <code>From:</code> es
					falsificable y el plano no lee ninguna por sí sola. Lee la cabecera{" "}
					<code>Authentication-Results</code> que tu propio proveedor escribió en el momento de la
					entrega, cuando comprobó DKIM y DMARC contra el dominio remitente con las claves de ese
					dominio tal como estaban entonces. El RFC 8601 hace que el proveedor receptor elimine
					cualquier copia ajena de esa cabecera a la entrada, así que la que queda es la que él
					escribió.
				</p>
				<p>
					Telegram acorrala a los desconocidos y los publica como participantes. El correo no: solo
					se lee lo que viene de la lista de abajo, y el de todos los demás se descarta. Un chat es
					una sala a la que alguien te dejó entrar, mientras que un buzón es una dirección que se
					filtra — cada mensaje leído gasta un turno, así que publicar lo que llegara pondría la
					factura del plano en manos de quien la encontrara.
				</p>
			</section>

			<section>
				<span className="eyebrow">Una cuenta, todos los agentes</span>
				<h2>La etiqueta es todo el diseño</h2>
				<Screen>{`
scout is reached at agents+scout@fastmail.com. Write to it and scout takes a turn.

That is agents@fastmail.com on imap.fastmail.com:993, and it serves every agent on this plane:
each one is reached at its own name tagged onto the address, and mail arriving with no tag on
it comes here, to scout.

scout answers from that same address and under the same subject, so what it writes back
arrives in the thread you started and a reply to that comes back to the same agent.

Mail from you@example.com is read as instructions and nobody else's is read at all: an
address strangers already have is one where every message read would spend a turn.

/email allow <address> adds somebody to that list, /email allow *@company.com adds everyone at
a domain, and /email deny takes them off. /email off puts the mailbox down, for every agent.
`}</Screen>
				<p>
					<code>agents+scout@</code> y <code>agents+clerk@</code> son una cuenta para el proveedor y
					dos agentes acá, así que un agente hecho mañana tiene dirección sin que nadie vuelva a una
					página de ajustes. El correo que llega sin etiqueta va al agente en el que se conectó el
					buzón.
				</p>
				<p>
					La respuesta vuelve desde la dirección etiquetada y no desde la cuenta, así que una
					contestación a ella regresa al agente que la escribió. Algunos proveedores reescriben un{" "}
					<code>From</code> que no es la cuenta que conocen, y por eso el <code>Reply-To</code> dice
					lo mismo otra vez: entre los dos, uno sobrevive.
				</p>
				<p className="small muted">
					Sale por duplicado: como el markdown que escribió el agente, y como el pequeño trozo de
					HTML que ese markdown describe — un buzón no es una terminal, y una respuesta enviada tal
					cual llega diciendo <code>**Chiste #1:**</code> con una fila de guiones debajo. El dibujo
					se hace acá y no con un parser que deje pasar HTML, y todo se escapa por el camino: un
					agente lee su correo, y un correo puede decirle que escriba cualquier cosa. Solo{" "}
					<code>http</code>, <code>https</code> y <code>mailto</code> se convierten en enlaces.
				</p>
			</section>

			<section>
				<span className="eyebrow">Quién más</span>
				<h2>Una lista, no una dirección</h2>
				<p>
					El emparejamiento vincula a la primera persona. La segunda es un compañero, y esperar a
					que envíe una frase por correo es peor respuesta que escribir su dirección — así que la
					lista es una lista, y se edita desde la consola o desde el prompt de cualquier agente
					mientras el buzón sigue conectado.
				</p>
				<Screen>{`
/email allow ana@company.com

ana@company.com can now instruct scout and every other agent on this plane, spending a turn for
each message, the same as whoever connected the mailbox.

/email deny ana@company.com stops it.
`}</Screen>
				<p>
					Una empresa entera de una vez es <code>/email allow *@company.com</code>, y un dominio
					escrito a secas significa lo mismo. Solo hay dos formas — una dirección o un dominio —
					porque esta lista es contra lo que se comprueba el buzón en cada mensaje, y un lenguaje de
					patrones acá sería una decisión de seguridad escrita en algo que nadie revisa.
				</p>
				<p>
					El comodín es seguro por la misma razón que lo es la frase de emparejamiento. La firma se
					comprueba contra el dominio del <code>From:</code> antes de consultar siquiera la lista,
					así que <code>*@company.com</code> significa aquel por quien firmó el servidor de correo
					de esa empresa — no quien escribió en una cabecera una dirección de esa empresa. Que es
					también por lo que se rechaza un comodín sobre gmail, iCloud o Proton: cualquiera puede
					tener una dirección en uno esta misma tarde, así que no nombraría una empresa, nombraría
					internet.
				</p>
				<div className="note">
					<p>
						<strong>Hay un solo peldaño.</strong> Todo el que está en esta lista gasta turnos e
						instruye a los agentes, igual que quien conectó el buzón. No hay un nivel menor que
						pueda preguntar pero no mandar, así que un dominio es una decisión sobre la factura
						tanto como sobre la confianza.
					</p>
				</div>
			</section>

			<section>
				<span className="eyebrow">La salida</span>
				<h2>El correo lo puede llevar otro</h2>
				<p>
					Un servidor de submission que rechaza esa misma contraseña es una razón. El volumen es
					otra — un buzón de consumo tiene un tope diario en alguna parte y no te dice dónde — y
					saber si llegó es la tercera: un servidor de submission acepta el mensaje y la historia
					termina ahí, mientras que una empresa que lleva correo para vivir tiene una respuesta
					sobre cada uno.
				</p>
				<Screen>{`
│ config                                                         │
│                                                                │
│ One mailbox serves every agent: mail to you+scout@ is scout's  │
│ and mail to you+clerk@ is clerk's, so connecting this is a     │
│ thing done once, including for the agents that do not exist    │
│ yet.                                                           │
│                                                                │
│ Reading is IMAP, which wants no domain and nothing open on     │
│ this machine. Sending is either the mailbox's own server, or a │
│ company that carries mail for a domain of yours and says       │
│ whether it landed.                                             │
│                                                                │
│ ● mailbox   agents@fastmail.com                                │
│ ● carrier   Mailgun                                            │
│ ● domain    squad.dev                                          │
│ ● key       MAILGUN_API_KEY                                    │
│                                                                │
│ who may write                                                  │
│                                                                │
│ ● you@example.com                                              │
│ ● *@squad.dev      everyone at squad.dev                       │
│ + an address                                                   │
`}</Screen>
				<p>
					Mailgun, Resend, Postmark y SendGrid aceptan cada uno un mensaje por HTTP, y cuál de ellos
					es una fila de la sección <code>email</code> de{" "}
					<Link href="/es/docs/config/">la pantalla de configuración</Link>. Hay un punto para cada
					mitad porque las dos mitades fallan por razones no relacionadas: un buzón que nadie
					conectó no alcanza nada, y un transportista que nadie pagó lee bien y no puede responder.
				</p>
				<p>
					Nombrar un transportista cambia quién entrega el mensaje y nada más. El <code>From</code>{" "}
					sigue siendo la dirección etiquetada del agente, el asunto y el message id de lo que entró
					se siguen guardando, así que una respuesta sigue volviendo al agente que la escribió. Lo
					que cambia es la reputación con la que sale el mensaje: la de tu propio proveedor, que ya
					tenés, o un dominio tuyo en un transportista, que calentás vos mismo.
				</p>
				<div className="note">
					<p>
						<strong>La clave del transportista no es una concesión del proxy.</strong> El plano
						envía el correo, no el sandbox — no hay contenedor en ese camino en el que escribir una
						cabecera — así que la clave se queda en el mismo archivo <code>0600</code> en el que se
						escriben todas las demás claves de proveedor y se lee en el momento del envío.
					</p>
				</div>
				<p className="small muted">
					<strong>Cloudflare pertenece al otro lado de esto.</strong> Email Routing recibe y
					reenvía; no envía. Para lo que sirve es para la mitad que el plano ya hacía por IMAP:
					apuntá el MX de un dominio tuyo a Cloudflare, reenviá al buzón corriente de arriba, y los
					agentes son alcanzables en tu propio dominio. La etiqueta no sobrevive a un catch-all, eso
					sí — un reenvío reescribe la entrega al buzón que se le dio, así que alcanzar a un agente
					concreto a través de uno exige una regla por agente dirigida a la dirección etiquetada de
					ese agente.
				</p>
			</section>

			<section>
				<span className="eyebrow">Lo que no se lee</span>
				<h2>La mayor parte de una bandeja de entrada no es para vos</h2>
				<Screen>{`
09:14:02  email     dropped     not on the list ×212
09:14:02  email     dropped     no agent "billing" ×3
`}</Screen>
				<p>
					Cualquiera que no esté en la lista, cualquier cosa auto-enviada, una etiqueta que no
					nombra a ningún agente, y el correo del propio buzón — sin esto último un agente en copia
					de su propia respuesta se despertaría a sí mismo, leería sus propias palabras como las de
					alguien, y lo volvería a hacer. Los descartes se cuentan por motivo en vez de listarse,
					porque un buzón que rechaza doscientos boletines vale una línea en el feed y no vale
					doscientas.
				</p>
				<p className="small muted">
					La contraseña de aplicación es una credencial viva y se trata como un token de bot: nunca
					se escribe en <code>config.yaml</code>, y se censura en la transcripción por qué comando
					era y no por su aspecto — una contraseña de aplicación son dieciséis letras corrientes, y
					ningún patrón que atrape una deja en paz a una frase. Un agente no puede ejecutar{" "}
					<code>/email</code>, por la razón por la que no puede ejecutar <code>/telegram</code>:
					conectar un buzón es elegir quién puede darle instrucciones.
				</p>
			</section>
		</Docs>
	);
}
