import { existsSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export class DockerError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "DockerError";
		this.status = status;
	}
}

export interface DockerResponse<T> {
	readonly status: number;
	readonly body: T;
}

export interface HijackedStream {
	readonly socket: Socket;
	/** Bytes Docker had already sent when the upgrade completed. Must be parsed before socket data. */
	readonly head: Buffer;
}

/**
 * Resolves the Docker socket. DOCKER_HOST wins; otherwise Docker Desktop's per-user socket is
 * preferred over /var/run/docker.sock, which on macOS is often a stale symlink.
 */
export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.DOCKER_HOST;
	if (fromEnv?.startsWith("unix://")) return fromEnv.slice("unix://".length);

	const candidates = [join(homedir(), ".docker", "run", "docker.sock"), "/var/run/docker.sock"];
	return candidates.find((candidate) => existsSync(candidate)) ?? "/var/run/docker.sock";
}

/** Minimal Docker Engine API client. Avoids a dependency and keeps the request surface explicit. */
export class DockerEngine {
	private readonly socketPath: string;

	constructor(socketPath: string = resolveSocketPath()) {
		this.socketPath = socketPath;
	}

	async request<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<DockerResponse<T>> {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");

		return new Promise<DockerResponse<T>>((resolve, reject) => {
			const request = http.request(
				{
					socketPath: this.socketPath,
					method,
					path,
					headers: {
						"content-type": "application/json",
						...(payload ? { "content-length": String(payload.byteLength) } : {}),
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						const status = response.statusCode ?? 0;
						let parsed: unknown;
						try {
							parsed = text.length > 0 ? JSON.parse(text) : undefined;
						} catch {
							parsed = text;
						}
						if (status >= 400) {
							const message =
								typeof parsed === "object" && parsed !== null && "message" in parsed
									? String((parsed as { message: unknown }).message)
									: text || `Docker returned ${status}`;
							reject(new DockerError(status, message));
							return;
						}
						resolve({ status, body: parsed as T });
					});
				},
			);
			request.on("error", reject);
			if (payload) request.write(payload);
			request.end();
		});
	}

	/** Returns the raw response body, for endpoints that stream instead of returning JSON. */
	async requestRaw(method: string, path: string, body?: unknown): Promise<Buffer> {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");

		return new Promise<Buffer>((resolve, reject) => {
			const request = http.request(
				{
					socketPath: this.socketPath,
					method,
					path,
					headers: {
						"content-type": "application/json",
						...(payload ? { "content-length": String(payload.byteLength) } : {}),
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () => {
						const buffer = Buffer.concat(chunks);
						const status = response.statusCode ?? 0;
						if (status >= 400) {
							reject(new DockerError(status, buffer.toString("utf8")));
							return;
						}
						resolve(buffer);
					});
				},
			);
			request.on("error", reject);
			if (payload) request.write(payload);
			request.end();
		});
	}

	/**
	 * Posts something that is not JSON and reads the answer as it arrives.
	 *
	 * For the endpoints that narrate rather than answer: a build sends a tar and then talks for
	 * several minutes, and a caller that only got the whole reply at the end would have nothing to
	 * show for the wait — which, on a machine slow enough for the wait to matter, is the whole of
	 * what somebody watching needs.
	 */
	async stream(
		method: string,
		path: string,
		body: Buffer,
		contentType: string,
		onChunk: (text: string) => void,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const request = http.request(
				{
					socketPath: this.socketPath,
					method,
					path,
					headers: { "content-type": contentType, "content-length": String(body.byteLength) },
				},
				(response) => {
					const status = response.statusCode ?? 0;
					const failure: Buffer[] = [];
					response.on("data", (chunk: Buffer) => {
						if (status >= 400) failure.push(chunk);
						else onChunk(chunk.toString("utf8"));
					});
					response.on("end", () => {
						if (status >= 400) {
							reject(new DockerError(status, Buffer.concat(failure).toString("utf8")));
							return;
						}
						resolve();
					});
				},
			);
			request.on("error", reject);
			request.end(body);
		});
	}

	/**
	 * Upgrades the connection and returns the raw socket, for endpoints Docker hijacks such as
	 * exec start with stdin attached. The socket is a full duplex: writes go to the process stdin,
	 * reads arrive as Docker's multiplexed frames unless the exec was created with a TTY.
	 */
	async hijack(method: string, path: string, body?: unknown): Promise<HijackedStream> {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");

		return new Promise<HijackedStream>((resolve, reject) => {
			const request = http.request({
				socketPath: this.socketPath,
				method,
				path,
				headers: {
					"content-type": "application/json",
					connection: "Upgrade",
					upgrade: "tcp",
					...(payload ? { "content-length": String(payload.byteLength) } : {}),
				},
			});

			request.on("upgrade", (_response, socket, head) => {
				socket.setNoDelay(true);
				resolve({ socket, head });
			});
			// Docker answers 200 without upgrading when it decides not to hijack, which for an
			// attached exec means the request was malformed rather than merely unsupported.
			request.on("response", (response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					reject(
						new DockerError(
							response.statusCode ?? 0,
							Buffer.concat(chunks).toString("utf8") || "Docker refused to hijack the connection",
						),
					);
				});
			});
			request.on("error", reject);
			if (payload) request.write(payload);
			request.end();
		});
	}

	async isAvailable(): Promise<boolean> {
		try {
			await this.request("GET", "/_ping");
			return true;
		} catch {
			return false;
		}
	}
}
