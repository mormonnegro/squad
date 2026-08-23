/** Something the agent wants to say back to where an event came from. */
export interface Reply {
	readonly agentId: string;
	/** The event's channel, e.g. "webhook:deploys". Its prefix selects the adapter. */
	readonly channel: string;
	readonly body: string;
	/** Adapter-specific address within the channel, copied from the event's replyTo. */
	readonly replyTo?: string;
}

export interface Channel {
	/** Prefix this adapter answers to, e.g. "webhook" for channel "webhook:deploys". */
	readonly name: string;
	send(reply: Reply): Promise<void>;
}

export class ChannelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChannelError";
	}
}

/**
 * Sends a reply back through the adapter the event arrived on.
 *
 * Routing on the event's own channel rather than on a configured destination is what keeps a
 * conversation in one place: an agent answering a GitHub webhook cannot be steered into replying
 * in Slack by anything written in the payload.
 */
export class ChannelRouter {
	readonly #channels = new Map<string, Channel>();

	register(channel: Channel): void {
		this.#channels.set(channel.name, channel);
	}

	async send(reply: Reply): Promise<void> {
		const [prefix] = reply.channel.split(":");
		const channel = prefix === undefined ? undefined : this.#channels.get(prefix);
		if (!channel) throw new ChannelError(`No channel registered for "${reply.channel}"`);
		await channel.send(reply);
	}
}
