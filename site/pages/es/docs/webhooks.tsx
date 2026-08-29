import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";

export default function Webhooks() {
	return (
		<Docs
			title="Webhooks"
			lede="El puerto 8787 es lo único publicado, y solo acepta peticiones firmadas. Un webhook despierta a un agente; nunca le dice qué hacer."
			description="Despertar a un agente desde cualquier cosa capaz de hacer una petición HTTP: declarar un hook, firmar el cuerpo y saber por qué un webhook nunca puede llevar confianza de operador."
		>
			<section>
				<span className="eyebrow">Declarado, no descubierto</span>
				<h2>Un hook es un bloque en el archivo de configuración</h2>
				<Code label="deploy/config.yaml">{`
hooks:
  - id: deploys
    agentId: scout
    # El nombre de una variable de entorno, no el secreto en sí.
    secretEnv: DEPLOY_HOOK_SECRET
    # El valor por defecto es "public". Un hook nunca puede ser "operator".
    trust: participant
    replyUrl: https://acme.example.com/agent-replies
`}</Code>
				<p>
					Eso hace que <code>POST /hooks/deploys</code> exista y pertenezca a <code>scout</code>. El
					secreto se nombra en vez de escribirse, así que el archivo que describe qué puede
					despertar a tus agentes sigue cabiendo en un commit y leyéndose en un diff.{" "}
					<code>replyUrl</code> es adonde se envía de vuelta la respuesta del agente, para un
					sistema que quiera una.
				</p>
				<p className="small muted">
					El instalador escribe un hook que funciona y genera su secreto en <code>.env</code>, así
					que hay uno que probar antes de que hayas escrito nada de esto.
				</p>
			</section>

			<section>
				<span className="eyebrow">Enviar uno</span>
				<h2>La firma cubre el timestamp y el cuerpo</h2>
				<Code wrap>{`
BODY='{"text":"the nightly build failed"}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$DEPLOY_HOOK_SECRET" -r | cut -d' ' -f1)"

curl -X POST http://localhost:8787/hooks/deploys \\
  -H "x-squad-timestamp: $TS" \\
  -H "x-squad-signature: $SIG" \\
  -d "$BODY"
`}</Code>
				<p>
					Se compara en tiempo constante dentro de una ventana de frescura. Un id de hook
					desconocido responde exactamente igual que una firma incorrecta, y solo después de haber
					leído el cuerpo, así que el endpoint no enumera — quien no tiene ningún secreto no puede
					averiguar por él qué hooks existen.
				</p>
			</section>

			<section>
				<span className="eyebrow">Lo que llega</span>
				<h2>Auténtico, y escrito aun así por cualquiera</h2>
				<p>
					Un webhook de GitHub lo firma GitHub y retransmite el cuerpo de un issue escrito por un
					desconocido. Así que un webhook no puede llevar{" "}
					<Link href="/es/docs/trust/">confianza de operador</Link>, por bien firmado que esté: el
					secreto prueba qué sistema envió la petición, nunca que un humano quisiera decir lo que
					hay dentro. El cuerpo llega vallado, presentado como datos, con un nonce aleatorio elegido
					después de escribir el contenido para que nada de dentro pueda cerrar la valla.
				</p>
				<p>
					Los eventos se encolan por agente y se pliegan en un único turno, así que un agente
					despertado veinte veces mientras está ocupado toma un turno sobre veinte cosas. Un turno
					que falla deja sus eventos encolados en vez de darlos por recibidos, así que una clave
					incorrecta cuesta un reintento en lugar del mensaje.
				</p>
				<p className="small muted">
					La respuesta se enruta por el canal del evento que la causó, así que a un agente que
					responde a un hook de GitHub nada en el payload puede llevarlo a responder por Telegram.
				</p>
			</section>

			<section>
				<span className="eyebrow">Las otras dos vías de entrada</span>
				<h2>Ninguna de las dos necesita un puerto</h2>
				<p>
					<Link href="/es/docs/telegram/">Telegram</Link> y{" "}
					<Link href="/es/docs/email/">el correo</Link> salen a buscar en vez de ser buscados, así
					que ninguno cuesta un dominio, un certificado ni nada publicado. Son también los dos que
					pueden emparejarse a una persona, que es lo que les permite instruir. Si nada necesita
					despertar a tus agentes desde fuera, el puerto 8787 es algo que no abres nunca.
				</p>
			</section>
		</Docs>
	);
}
