import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import type { CertificateAuthority } from "./ca.ts";
import { pushRefusal, readPushHead, refMatches } from "./git.ts";
import { type DenyReason, type GrantSet, isPush, normalizeHost, normalizePath } from "./grants.ts";
import { applyInjection } from "./inject.ts";
import { MissingSecretError, type SecretStore } from "./secrets.ts";

export interface AuditEntry {
	readonly at: string;
	readonly agentId: string | undefined;
	readonly host: string;
	readonly method: string;
	/** Normalized path with the query string removed, so injected query credentials never land here. */
	readonly path: string;
	readonly outcome: "allowed" | "denied" | "error";
	readonly reason?: DenyReason | "unauthenticated" | "missing_secret" | "upstream_error";
	readonly grantId?: string | undefined;
	readonly status?: number | undefined;
	/** The refs a push was for, read off its body, which is the line worth having when it went wrong. */
	readonly refs?: readonly string[] | undefined;
}

export interface AgentDirectory {
	/** Maps proxy credentials to an agent id. Returns undefined when the credentials are unknown. */
	authenticate(username: string, password: string): string | undefined;
	grantsFor(agentId: string): GrantSet | undefined;
}

export interface EgressBrokerOptions {
	readonly ca: CertificateAuthority;
	readonly secrets: SecretStore;
	readonly directory: AgentDirectory;
	readonly onAudit?: (entry: AuditEntry) => void;
	/** Overrides the agent used for upstream TLS, for private PKI or connection pooling. */
	readonly upstreamAgent?: https.Agent;
}

interface TunnelContext {
	readonly agentId: string;
	readonly host: string;
	readonly port: number;
}

const TUNNEL_CONTEXT = Symbol("squad.tunnelContext");

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
	}
	return result;
}

function parseProxyAuth(
	header: string | undefined,
): { username: string; password: string } | undefined {
	if (header === undefined) return undefined;
	const [scheme, encoded] = header.split(" ");
	if (scheme?.toLowerCase() !== "basic" || encoded === undefined) return undefined;
	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	const separator = decoded.indexOf(":");
	if (separator === -1) return undefined;
	return {
		username: decoded.slice(0, separator),
		password: decoded.slice(separator + 1),
	};
}

function parseAuthority(authority: string, fallbackPort: number): { host: string; port: number } {
	const match = /^\[(?<v6>.+)\](?::(?<p6>\d+))?$/.exec(authority);
	if (match?.groups) {
		return {
			host: match.groups.v6 ?? "",
			port: Number(match.groups.p6 ?? fallbackPort),
		};
	}
	const separator = authority.lastIndexOf(":");
	if (separator === -1) return { host: authority, port: fallbackPort };
	return {
		host: authority.slice(0, separator),
		port: Number(authority.slice(separator + 1)),
	};
}

/**
 * Forward proxy that terminates TLS with a local CA, checks every request against the
 * agent's grants, and injects credentials on the wire. The agent holds no secret: it only
 * ever holds proxy credentials that identify it.
 */
export class EgressBroker {
	private readonly options: EgressBrokerOptions;
	private readonly server: http.Server;
	private readonly tunnelServer: http.Server;

	constructor(options: EgressBrokerOptions) {
		this.options = options;
		this.tunnelServer = http.createServer((req, res) => {
			const context = (req.socket as unknown as Record<symbol, TunnelContext | undefined>)[
				TUNNEL_CONTEXT
			];
			if (context === undefined) {
				res.writeHead(500).end();
				return;
			}
			void this.forward(req, res, context, "https");
		});

		this.server = http.createServer((req, res) => void this.handlePlainRequest(req, res));
		this.server.on("connect", (req, socket, head) => this.handleConnect(req, socket, head));
	}

	get caCertPem(): string {
		return this.options.ca.caCertPem;
	}

	async listen(port = 0, hostname = "127.0.0.1"): Promise<AddressInfo> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, hostname, () => {
				this.server.removeListener("error", reject);
				resolve();
			});
		});
		return this.server.address() as AddressInfo;
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		this.tunnelServer.closeAllConnections();
	}

	private audit(entry: AuditEntry): void {
		this.options.onAudit?.(entry);
	}

	private authenticate(headers: http.IncomingHttpHeaders): string | undefined {
		const credentials = parseProxyAuth(
			Array.isArray(headers["proxy-authorization"])
				? headers["proxy-authorization"][0]
				: headers["proxy-authorization"],
		);
		if (credentials === undefined) return undefined;
		return this.options.directory.authenticate(credentials.username, credentials.password);
	}

	private handleConnect(
		req: http.IncomingMessage,
		socket: import("node:stream").Duplex,
		head: Buffer,
	): void {
		const { host, port } = parseAuthority(req.url ?? "", 443);
		const normalizedHost = normalizeHost(host);
		const agentId = this.authenticate(req.headers);

		if (agentId === undefined) {
			this.audit({
				at: new Date().toISOString(),
				agentId: undefined,
				host: normalizedHost,
				method: "CONNECT",
				path: "/",
				outcome: "denied",
				reason: "unauthenticated",
			});
			socket.end(
				'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="squad"\r\n\r\n',
			);
			return;
		}

		const grants = this.options.directory.grantsFor(agentId);
		if (grants === undefined || !grants.allowsHost(normalizedHost)) {
			this.audit({
				at: new Date().toISOString(),
				agentId,
				host: normalizedHost,
				method: "CONNECT",
				path: "/",
				outcome: "denied",
				reason: "no_matching_host",
			});
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}

		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

		const { certPem, keyPem } = this.options.ca.issue(normalizedHost);
		const tlsSocket = new tls.TLSSocket(socket, {
			isServer: true,
			cert: certPem,
			key: keyPem,
		});
		tlsSocket.on("error", () => tlsSocket.destroy());
		(tlsSocket as unknown as Record<symbol, TunnelContext>)[TUNNEL_CONTEXT] = {
			agentId,
			host: normalizedHost,
			port,
		};
		if (head.length > 0) tlsSocket.unshift(head);
		this.tunnelServer.emit("connection", tlsSocket);
	}

	private handlePlainRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const agentId = this.authenticate(req.headers);
		let target: URL;
		try {
			target = new URL(req.url ?? "");
		} catch {
			res.writeHead(400).end();
			return;
		}

		const normalizedHost = normalizeHost(target.host);
		if (agentId === undefined) {
			this.audit({
				at: new Date().toISOString(),
				agentId: undefined,
				host: normalizedHost,
				method: req.method ?? "GET",
				path: normalizePath(target.pathname),
				outcome: "denied",
				reason: "unauthenticated",
			});
			res.writeHead(407, { "proxy-authenticate": 'Basic realm="squad"' }).end();
			return;
		}

		req.url = `${target.pathname}${target.search}`;
		void this.forward(
			req,
			res,
			{ agentId, host: normalizedHost, port: Number(target.port || 80) },
			"http",
		);
	}

	private async forward(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		context: TunnelContext,
		scheme: "http" | "https",
	): Promise<void> {
		const method = req.method ?? "GET";
		const rawPath = req.url ?? "/";
		const auditPath = normalizePath(rawPath);
		const at = new Date().toISOString();

		const grants = this.options.directory.grantsFor(context.agentId);
		const decision = grants?.resolve({
			host: context.host,
			method,
			path: rawPath,
		});

		if (decision === undefined || !decision.allow) {
			const reason: DenyReason = decision?.allow === false ? decision.reason : "no_matching_host";
			this.audit({
				at,
				agentId: context.agentId,
				host: context.host,
				method,
				path: auditPath,
				outcome: "denied",
				reason,
			});
			res.writeHead(403, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					error: "egress_denied",
					reason,
					host: context.host,
					path: auditPath,
				}),
			);
			return;
		}

		// A push is read before it is passed. The branch is in the head of the body, so the body is read
		// to the end of its commands and the upstream is opened only once every ref on it is granted —
		// see git.ts for why a refusal is written as a receive-pack report rather than a 403.
		let head: { readonly bytes: Buffer; readonly ended: boolean } | undefined;
		let refs: readonly string[] | undefined;
		const scope = decision.grant.git;
		if (scope !== undefined && isPush(method, auditPath)) {
			const encoding = req.headers["content-encoding"];
			const push =
				encoding !== undefined && encoding !== "identity"
					? {
							bytes: Buffer.alloc(0),
							ended: false,
							commands: { kind: "unreadable", why: `the body is ${encoding}-encoded` } as const,
						}
					: await readPushHead(req);
			if (push.commands.kind !== "commands") {
				this.audit({
					at,
					agentId: context.agentId,
					host: context.host,
					method,
					path: auditPath,
					outcome: "denied",
					reason: "push_unreadable",
					grantId: decision.grant.id,
				});
				res.writeHead(403, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: "egress_denied",
						reason: "push_unreadable",
						why: push.commands.why,
					}),
				);
				req.resume();
				return;
			}
			const { updates, capabilities } = push.commands;
			refs = updates.map((update) => update.ref);
			const refused = refs.filter((ref) => !refMatches(scope.push, ref));
			if (refused.length > 0) {
				this.audit({
					at,
					agentId: context.agentId,
					host: context.host,
					method,
					path: auditPath,
					outcome: "denied",
					reason: "ref_not_granted",
					grantId: decision.grant.id,
					refs,
				});
				res.writeHead(200, {
					"content-type": "application/x-git-receive-pack-result",
					"cache-control": "no-cache",
				});
				res.end(pushRefusal(updates, capabilities, refused, scope.push));
				req.resume();
				return;
			}
			head = { bytes: push.bytes, ended: push.ended };
		}

		let outbound: Awaited<ReturnType<typeof applyInjection>>;
		try {
			outbound = await applyInjection(decision.grant.injection, this.options.secrets, {
				path: rawPath,
				headers: flattenHeaders(req.headers),
			});
		} catch (error) {
			const reason = error instanceof MissingSecretError ? "missing_secret" : "upstream_error";
			this.audit({
				at,
				agentId: context.agentId,
				host: context.host,
				method,
				path: auditPath,
				outcome: "error",
				reason,
				grantId: decision.grant.id,
			});
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "egress_credential_unavailable" }));
			return;
		}

		const transport = scheme === "https" ? https : http;
		const upstream = transport.request({
			host: context.host,
			port: context.port,
			method,
			path: outbound.path,
			headers: { ...outbound.headers, host: context.host },
			...(scheme === "https"
				? {
						servername: context.host,
						...(this.options.upstreamAgent ? { agent: this.options.upstreamAgent } : {}),
					}
				: {}),
		});

		upstream.on("response", (upstreamRes) => {
			this.audit({
				at,
				agentId: context.agentId,
				host: context.host,
				method,
				path: auditPath,
				outcome: "allowed",
				grantId: decision.grant.id,
				status: upstreamRes.statusCode,
				...(refs !== undefined ? { refs } : {}),
			});
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		});

		upstream.on("error", () => {
			this.audit({
				at,
				agentId: context.agentId,
				host: context.host,
				method,
				path: auditPath,
				outcome: "error",
				reason: "upstream_error",
				grantId: decision.grant.id,
			});
			if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "upstream_unreachable" }));
		});

		if (head === undefined) {
			req.pipe(upstream);
			return;
		}
		// What was read to decide goes first, and the body carries on from where the reading paused it.
		upstream.write(head.bytes);
		if (head.ended) upstream.end();
		else req.pipe(upstream);
	}
}
