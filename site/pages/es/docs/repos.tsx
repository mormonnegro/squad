import Link from "next/link";
import { Code } from "../../../components/Code";
import { Docs } from "../../../components/Docs";
import { Screen } from "../../../components/Screen";

export default function Repos() {
	return (
		<Docs
			title="Repositorios"
			lede="Una concesión sobre el host de un repositorio, con un token puesto, es una concesión para pushear a cualquier parte del repositorio, main incluida. Por eso un repositorio se da junto con las ramas que vienen con él, y el proxy lee cada push antes de dejarlo pasar."
			description="Cómo funciona /repo: cuatro palabras que se vuelven tres concesiones, las ramas a las que un agente puede pushear, un push a main rechazado con las palabras de git, y el token que el agente nunca tiene."
		>
			<section>
				<span className="eyebrow">Darle uno</span>
				<h2>Cuatro palabras, tres concesiones</h2>
				<Screen>{`
│ › /repo acme/website                                             │
│   This plane holds no GitHub token. Make a fine-grained one at   │
│   https://github.com/settings/personal-access-tokens/new with    │
│   Contents: read and write on acme/website — and Pull requests:  │
│   read and write, if it should open them — then paste it here:   │
│   /repo github_pat_…                                             │
│                                                                  │
│   It is kept here, spent by the proxy, and never given to an     │
│   agent.                                                         │
│                                                                  │
│ › /repo …                                                        │
│   scout holds https://github.com/acme/website. It can clone it   │
│   and push to scout/*; a push to any other branch is refused     │
│   before it leaves, and it can open pull requests. The token     │
│   stays here, never in the sandbox.                              │
`}</Screen>
				<p>
					Lo que el plano deriva de <code>acme/website</code> son tres concesiones, ninguna escrita
					a mano: <code>github.com</code> bajo <code>/acme/website</code>, con el alcance de push
					encima y el token puesto como basic auth, que es el clone y el push;{" "}
					<code>api.github.com</code> bajo <code>/repos/acme/website</code> para <code>GET</code>,
					que es leer; y bajo <code>/repos/acme/website/pulls</code> también para <code>POST</code>{" "}
					y <code>PATCH</code>, que es abrir un pull request. Dos concesiones de API en vez de una
					porque la API es por donde se podría rodear el alcance de ramas — un <code>PUT</code> en{" "}
					<code>contents/</code> commitea a cualquier rama, un <code>PATCH</code> en{" "}
					<code>git/refs/</code> mueve cualquier ref, un <code>POST</code> en <code>merges</code>{" "}
					mergea a main. Abrir un PR es la única escritura que recibe; mergearlo es un{" "}
					<code>PUT</code> que no se le da.
				</p>
				<p className="small muted">
					El token es del plano, uno solo para todos los repositorios que se den acá, guardado al
					lado de las claves de proveedor como <code>GITHUB_TOKEN</code> — exportarlo en el entorno
					del plano también funciona, y lo que se pega en una consola gana. Un token fine-grained
					responde solo por los repositorios que le diste, así que dale los que vas a repartir y
					nada más: es el cinturón debajo del alcance del proxy, no una segunda copia. El
					repositorio responde bajo su nombre con <code>.git</code> al final y también sin él,
					porque el agente pega el que le mostró la caja de clone.
				</p>
			</section>

			<section>
				<span className="eyebrow">Las ramas</span>
				<h2>Su propio carril, salvo que digas otra cosa</h2>
				<p>
					Si no se dice nada, las ramas son el nombre del agente y todo lo que cuelga de él —{" "}
					<code>scout/*</code> — así que nada cae en main porque nadie dijo qué ramas.{" "}
					<code>/repo acme/website fix/* docs</code> las nombra en cambio. Un patrón tiene la forma
					de un refspec: un nombre pelado es una rama, <code>*</code> vale por cualquier cosa,
					barras incluidas, y <code>*</code> solo es cualquier parte. Decir <code>/repo</code> de
					nuevo para un repositorio que ya tiene cambia a dónde puede pushear, no agrega una fila.
				</p>
				<Screen>{`
│ $ git push origin main                                                 │
│ remote: squad: main is not granted to this agent; push scout/* here    │
│ To https://github.com/acme/website                                     │
│  ! [remote rejected] main -> main (not granted: push scout/* here)     │
│ error: failed to push some refs to 'https://github.com/acme/website'   │
`}</Screen>
				<p>
					La rama está en la cabecera del propio push: una línea por ref, cerrada por un flush, y el
					packfile después. El proxy lee hasta el flush antes de abrir nada hacia arriba, y si una
					ref no está en la lista no pasa nada — ni el packfile, ni las otras refs que iban con
					ella. El rechazo no es un 403, porque un 403 le llega a git como{" "}
					<code>RPC failed; HTTP 403</code>, que es exactamente lo que parece un token equivocado, y
					un agente que lee eso se va a revisar el token. Lo que git imprime palabra por palabra es
					el reporte del servidor, así que el proxy rechaza como lo haría un hook de pre-receive,
					nombrando la rama que negó y las que tiene. El log de auditoría lleva las refs de cada
					push, pasado o no.
				</p>
			</section>

			<section>
				<span className="eyebrow">Lo que se le dice al agente</span>
				<h2>Dicho en cada turno, después de las reglas de la casa</h2>
				<p>
					Una concesión que nadie menciona es una concesión que se descubre a los tumbos — clonando
					con el nombre equivocado y encontrando un 403, o pusheando a main y encontrando un rechazo
					que no sabía que venía. Así que el plano le dice al agente qué tiene al empezar cada
					turno, como le dice las <Link href="/es/docs/agents/">reglas de la casa</Link>: la URL,
					dónde va el checkout dentro de su workspace, y las ramas a las que puede pushear. Sus
					commits llevan su propio nombre, y el git del sandbox nunca se detiene a pedir una
					contraseña, porque la credencial la pone el proxy y un prompt sería un turno colgado de
					una pregunta que nadie contesta.
				</p>
				<Screen>{`
│ › /repo                                                                │
│   scout holds:                                                         │
│     https://github.com/acme/website  push scout/*     from here        │
│     https://github.com/acme/api      push fix/* docs  from the file    │
│                                                                        │
│   /repo drop <owner/name> takes one back; /repo <owner/name>           │
│   <branch>… changes what it may push.                                  │
`}</Screen>
				<p className="small muted">
					Un agente puede pedir <code>/repo</code> para ver qué tiene, y no puede pedir tener uno:
					tener un repositorio gasta tu token en él, y un token que un agente tiene en la mano es
					uno que sacó de algo que leyó. El rechazo dice qué línea te toca escribir a vos, y nunca
					imprime el token.
				</p>
			</section>

			<section>
				<span className="eyebrow">Lo que no pretende</span>
				<h2>Un force push parece un push</h2>
				<p>
					El proxy ve las refs y no la historia que hay detrás, así que un force push a una rama a
					la que el agente puede pushear pasa, y borrarla también. Nada de main cambia de manos en
					ningún caso, y esa es la promesa: las ramas que nombraste son las ramas que puede tocar.
					El segundo cinturón es de GitHub, un ruleset sobre main que rechace el push directo, con
					bypass para vos — vale la pena porque el token es del plano y vive fuera del sandbox,
					donde el proxy no es lo que lo cuida.
				</p>
				<p>
					Las mismas cuatro palabras van en <code>deploy/config.yaml</code>, bajo el agente, y lo
					que el archivo declara la consola se lo deja al archivo:
				</p>
				<Code label="deploy/config.yaml">{`
agents:
  - id: scout
    repos:
      - repo: acme/website
      - repo: acme/api
        push: [fix/*, docs]
`}</Code>
				<p className="small muted">
					<Link href="/es/docs/grants/">Alcance</Link> es qué es una concesión y dónde queda la
					credencial, y esto es una forma de concesión con un alcance que el método no podía llevar.
				</p>
			</section>
		</Docs>
	);
}
