import { existsSync } from "node:fs";
import http from "node:http";
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

	async isAvailable(): Promise<boolean> {
		try {
			await this.request("GET", "/_ping");
			return true;
		} catch {
			return false;
		}
	}
}
