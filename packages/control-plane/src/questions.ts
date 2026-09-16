import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A question an agent has put to its operator, and the answers it wrote for them to press.
 *
 * The thing this replaces is a paragraph. An agent one decision from carrying on — which of these
 * three fares, which of the two readings of what you asked for, shall I go on to the checkout —
 * used to end its turn by writing the decision out and putting a question mark on the end of it.
 * That is read twenty minutes later by somebody who then has to type an answer precise enough to
 * act on, and who quite often answers a different question from the one asked.
 *
 * So the answers come with it. Each option is the message it sends: pressing "Comfort $793" puts
 * exactly that line into the conversation as the operator's, in a turn of its own, and there is no
 * translation step at either end. Which is also why the plane keeps almost nothing of its own here
 * — the words are the agent's, the click is the operator's, and this is the shape they meet in.
 */
export interface Question {
	readonly text: string;
	readonly options: readonly string[];
	/**
	 * Set when what is wanted is the operator's hands rather than their answer.
	 *
	 * The console draws one more thing on a card that says so: the button that takes the keyboard off
	 * the agent and puts its browser in front of the person. It is not an answer and does not close
	 * the question — somebody who takes the keyboard to sign in has not yet said whether it worked.
	 */
	readonly hands?: boolean;
}

/**
 * How many an agent may have standing at once.
 *
 * Three, and hard, because every one of them is a stop. A turn that ended with five cards on the
 * screen is a turn that handed its work back rather than did any, and the console that has to draw
 * them is the conversation itself — five is a pane with no conversation left in it.
 */
export const MOST_QUESTIONS = 3;

/** How many answers one question may offer: a column read at a glance, and not a menu. */
export const MOST_OPTIONS = 6;

/** A button, not a paragraph. */
export const OPTION_CHARS = 140;

/** Enough to say what is being decided, with the buttons still on the screen under it. */
export const QUESTION_CHARS = 700;

function readOne(value: unknown): Question | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { text, options, hands } = value as Record<string, unknown>;
	if (typeof text !== "string") return undefined;
	const asked = text.trim();
	if (asked.length === 0) return undefined;
	const offered = Array.isArray(options) ? options : [];
	const kept = offered
		.filter((one): one is string => typeof one === "string")
		.map((one) => one.trim())
		.filter((one) => one !== "" && one.length <= OPTION_CHARS);
	// A card with nothing to press is a paragraph again, and the one exception is the card that
	// already has a button on it: asking for hands puts the keyboard where the operator can take it,
	// whatever else was written.
	if (kept.length === 0 && hands !== true) return undefined;
	return {
		text: asked.slice(0, QUESTION_CHARS),
		options: [...new Set(kept)].slice(0, MOST_OPTIONS),
		...(hands === true ? { hands: true } : {}),
	};
}

/**
 * Reads the questions a turn left behind, dropping anything that does not read as one.
 *
 * Read here as well as written by a tool, because the tool is a convenience inside a sandbox where
 * the agent has a shell and could write this file by hand. One at a time rather than all or nothing,
 * on the console queue's terms: an agent that got its second card wrong should still have its first
 * one put up.
 */
export function parseQuestions(text: string): readonly Question[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	return parsed
		.map(readOne)
		.filter((one): one is Question => one !== undefined)
		.slice(0, MOST_QUESTIONS);
}

/**
 * The questions each agent has standing, on disk.
 *
 * The only one of the four things an agent waits on that has to survive a restart, and the reason is
 * what happens if it does not. A host an agent could not reach is asked about again the moment it is
 * refused again — the agent is the thing that knows whether it still needs it, and it finds out by
 * trying. A question has no such second chance: nothing makes an agent ask twice, so a card dropped
 * by a restart is an agent waiting forever for an answer nobody can give it, and an operator who
 * watched the thing they were about to press disappear.
 *
 * Kept beside the other things a console decided rather than in the operator's file, on the same
 * terms as every one of them: the file is theirs, and a plane that wrote to it would be rewriting
 * the one document they read to find out what they had agreed to.
 */
export class StandingQuestions {
	readonly #path: string;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async all(): Promise<Record<string, readonly Question[]>> {
		return await this.#serialize(() => this.#read());
	}

	async of(agentId: string): Promise<readonly Question[]> {
		return await this.#serialize(async () => (await this.#read())[agentId] ?? []);
	}

	/** Replaces whatever this agent had, which is what a turn that asked something does to a card. */
	async put(agentId: string, questions: readonly Question[]): Promise<void> {
		await this.#serialize(async () => {
			await this.#write({ ...(await this.#read()), [agentId]: [...questions] });
		});
	}

	async forget(agentId: string): Promise<void> {
		await this.#serialize(async () => {
			const { [agentId]: _gone, ...left } = await this.#read();
			await this.#write(left);
		});
	}

	async #read(): Promise<Record<string, Question[]>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			const all: Record<string, Question[]> = {};
			for (const [agentId, held] of Object.entries(parsed as Record<string, unknown>)) {
				// Read on the way in the way a turn's file is read, because it is the same shape and the
				// same question: nothing that cannot be answered by pressing something belongs on a card.
				const kept = parseQuestions(JSON.stringify(held));
				if (kept !== undefined && kept.length > 0) all[agentId] = [...kept];
			}
			return all;
		} catch {
			return {};
		}
	}

	async #write(all: Record<string, readonly Question[]>): Promise<void> {
		const kept = Object.fromEntries(Object.entries(all).filter(([, held]) => held.length > 0));
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(kept, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, this.#path);
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.catch(() => {});
		return result;
	}
}
