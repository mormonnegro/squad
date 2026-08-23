export class CronError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CronError";
	}
}

interface Field {
	readonly values: ReadonlySet<number>;
	/** A bare "*" is treated as "no opinion", which day-of-month and day-of-week depend on. */
	readonly unrestricted: boolean;
}

export interface CronExpression {
	readonly minute: Field;
	readonly hour: Field;
	readonly dayOfMonth: Field;
	readonly month: Field;
	readonly dayOfWeek: Field;
}

const RANGES = {
	minute: [0, 59],
	hour: [0, 23],
	dayOfMonth: [1, 31],
	month: [1, 12],
	dayOfWeek: [0, 7],
} as const;

const MONTH_NAMES = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseValue(raw: string, field: keyof typeof RANGES): number {
	const text = raw.trim().toLowerCase();
	const named =
		field === "month"
			? MONTH_NAMES.indexOf(text) + 1
			: field === "dayOfWeek"
				? DAY_NAMES.indexOf(text)
				: -1;
	if (named > (field === "month" ? 0 : -1)) return named;

	if (!/^\d+$/.test(text)) throw new CronError(`Invalid ${field} value "${raw}"`);
	const value = Number(text);
	const [low, high] = RANGES[field];
	if (value < low || value > high) {
		throw new CronError(`${field} value ${value} is outside ${low}-${high}`);
	}
	return value;
}

function parseField(raw: string, field: keyof typeof RANGES): Field {
	const values = new Set<number>();
	let unrestricted = false;

	for (const part of raw.split(",")) {
		const [spec, stepText] = part.split("/");
		if (spec === undefined || spec.length === 0) throw new CronError(`Empty ${field} field`);

		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1)
			throw new CronError(`Invalid ${field} step "${stepText}"`);

		const [low, high] = RANGES[field];
		let start: number;
		let end: number;
		if (spec === "*") {
			if (stepText === undefined) unrestricted = true;
			start = low;
			end = high;
		} else if (spec.includes("-")) {
			const [from, to] = spec.split("-");
			start = parseValue(from ?? "", field);
			end = parseValue(to ?? "", field);
			if (end < start) throw new CronError(`${field} range "${spec}" ends before it starts`);
		} else {
			start = parseValue(spec, field);
			end = stepText === undefined ? start : high;
		}

		for (let value = start; value <= end; value += step) values.add(value);
	}

	// Cron accepts both 0 and 7 for Sunday; normalizing here keeps the matcher simple.
	if (field === "dayOfWeek" && values.delete(7)) values.add(0);
	if (values.size === 0) throw new CronError(`${field} field matches nothing`);
	return { values, unrestricted };
}

/** Parses a five-field cron expression: minute, hour, day of month, month, day of week. */
export function parseCron(expression: string): CronExpression {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new CronError(`Expected 5 cron fields, got ${fields.length} in "${expression}"`);
	}

	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
		string,
		string,
		string,
		string,
		string,
	];
	return {
		minute: parseField(minute, "minute"),
		hour: parseField(hour, "hour"),
		dayOfMonth: parseField(dayOfMonth, "dayOfMonth"),
		month: parseField(month, "month"),
		dayOfWeek: parseField(dayOfWeek, "dayOfWeek"),
	};
}

interface ZonedParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	const existing = formatters.get(timeZone);
	if (existing) return existing;

	let created: Intl.DateTimeFormat;
	try {
		created = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "short",
		});
	} catch {
		throw new CronError(`Unknown time zone "${timeZone}"`);
	}
	formatters.set(timeZone, created);
	return created;
}

/** Reads the wall-clock fields an instant has in a given zone, which is what cron matches on. */
function partsIn(instant: Date, timeZone: string): ZonedParts {
	const parts = new Map(
		formatterFor(timeZone)
			.formatToParts(instant)
			.map((part) => [part.type, part.value]),
	);

	// Hour 24 appears at midnight in some locales' 24-hour formatting.
	const hour = Number(parts.get("hour") ?? "0") % 24;
	return {
		year: Number(parts.get("year")),
		month: Number(parts.get("month")),
		day: Number(parts.get("day")),
		hour,
		minute: Number(parts.get("minute")),
		weekday: DAY_NAMES.indexOf((parts.get("weekday") ?? "").toLowerCase()),
	};
}

/**
 * Day matching follows Vixie cron: when both day-of-month and day-of-week are restricted the
 * expression fires if either matches, which is why "0 0 1 * mon" means the 1st *or* any Monday.
 */
function dayMatches(cron: CronExpression, parts: ZonedParts): boolean {
	if (!cron.month.values.has(parts.month)) return false;

	const domRestricted = !cron.dayOfMonth.unrestricted;
	const dowRestricted = !cron.dayOfWeek.unrestricted;
	const dom = cron.dayOfMonth.values.has(parts.day);
	const dow = cron.dayOfWeek.values.has(parts.weekday);

	if (domRestricted && dowRestricted) return dom || dow;
	if (domRestricted) return dom;
	if (dowRestricted) return dow;
	return true;
}

const MINUTE_MS = 60_000;
const MAX_ITERATIONS = 200_000;

/**
 * The next instant strictly after `from` at which the expression fires in the given zone.
 *
 * Candidates are checked against wall-clock fields rather than computed arithmetically, so a
 * daily job keeps its local time across a daylight-saving change instead of drifting by an hour.
 * When a candidate's date or hour cannot match, the search jumps to the next day or hour rather
 * than walking every minute, and re-derives the zone's fields afterwards so the jump does not have
 * to be exact.
 */
export function nextRun(expression: string, from: Date, timeZone = "UTC"): Date {
	const cron = parseCron(expression);
	const horizon = from.getTime() + 5 * 366 * 24 * 60 * MINUTE_MS;

	let candidate = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

	for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
		if (candidate > horizon) break;
		const parts = partsIn(new Date(candidate), timeZone);

		if (!dayMatches(cron, parts)) {
			candidate += (24 * 60 - (parts.hour * 60 + parts.minute)) * MINUTE_MS;
			continue;
		}
		if (!cron.hour.values.has(parts.hour)) {
			candidate += (60 - parts.minute) * MINUTE_MS;
			continue;
		}
		if (!cron.minute.values.has(parts.minute)) {
			candidate += MINUTE_MS;
			continue;
		}
		return new Date(candidate);
	}

	throw new CronError(`"${expression}" has no next run within five years in ${timeZone}`);
}
