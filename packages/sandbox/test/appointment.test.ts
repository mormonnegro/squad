import { describe, expect, it } from "vitest";
import { Appointment, MAX_SECONDS, MIN_SECONDS } from "../image/appointment.ts";

/** Noon of a day with nothing else in it, so the times in the messages read as arithmetic. */
const NOW = Date.parse("2026-08-26T12:00:00.000Z");

/** Stands in for the file, and keeps what was written so a test can say what the plane would find. */
function pad(): { left: Record<string, unknown>[]; leave: (r: Record<string, unknown>) => void } {
	const left: Record<string, unknown>[] = [];
	return { left, leave: (request) => void left.push(request) };
}

describe("Appointment", () => {
	it("leaves the plane the request, and tells the agent when it will be woken", () => {
		const { left, leave } = pad();
		const appointment = new Appointment();

		const asked = appointment.book(600, "seguir con el informe", leave, NOW);

		expect(left).toEqual([{ afterSeconds: 600, note: "seguir con el informe" }]);
		expect(asked.text).toContain("2026-08-26T12:10:00.000Z");
		expect(asked.text).toContain("seguir con el informe");
	});

	/**
	 * The runaway. An agent asked for a joke a minute told two hundred inside one turn, because it read
	 * the confirmation as the waiting being over. The second ask has to fail, and has to say why.
	 */
	it("refuses a second booking in the same turn, and says the wait cannot be waited out", () => {
		const { left, leave } = pad();
		const appointment = new Appointment();
		appointment.book(60, "el próximo chiste", leave, NOW);

		expect(() => appointment.book(60, "el próximo chiste", leave, NOW)).toThrow(
			/already asked.*2026-08-26T12:01:00\.000Z/s,
		);
		expect(left).toHaveLength(1);
	});

	it("lets a turn book again once it has cancelled", () => {
		const { left, leave } = pad();
		const appointment = new Appointment();
		appointment.book(60, "primera", leave, NOW);

		const dropped = appointment.cancel(leave);
		const again = appointment.book(120, "segunda", leave, NOW);

		expect(dropped.request).toEqual({ cancel: true });
		expect(left).toEqual([
			{ afterSeconds: 60, note: "primera" },
			{ cancel: true },
			{ afterSeconds: 120, note: "segunda" },
		]);
		expect(again.text).toContain("2026-08-26T12:02:00.000Z");
	});

	/**
	 * The order is the whole point of the callback. If the write fails the agent has to be free to ask
	 * again, rather than told it is booked for a turn that nothing will ever come for.
	 */
	it("keeps the appointment only if the request was left", () => {
		const appointment = new Appointment();
		const failing = () => {
			throw new Error("read-only file system");
		};

		expect(() => appointment.book(60, "seguir", failing, NOW)).toThrow("read-only file system");

		const { left, leave } = pad();
		expect(() => appointment.book(60, "seguir", leave, NOW)).not.toThrow();
		expect(left).toHaveLength(1);
	});

	it("refuses a wakeup sooner than the plane can honour", () => {
		const { left, leave } = pad();

		expect(() => new Appointment().book(MIN_SECONDS - 1, "ya", leave, NOW)).toThrow(
			`The soonest you can be woken is ${MIN_SECONDS} seconds from now.`,
		);
		expect(left).toEqual([]);
	});

	it("refuses a wakeup further off than a month", () => {
		const { leave } = pad();

		expect(() => new Appointment().book(MAX_SECONDS + 1, "algún día", leave, NOW)).toThrow(
			`The furthest you can be woken is ${MAX_SECONDS} seconds from now.`,
		);
	});

	/** A fraction of a second is not a time the plane schedules on, and rounding it would be guessing. */
	it("refuses a count of seconds that is not one", () => {
		const { leave } = pad();

		expect(() => new Appointment().book(1.5, "seguir", leave, NOW)).toThrow(/soonest/);
		expect(() => new Appointment().book(Number.NaN, "seguir", leave, NOW)).toThrow(/soonest/);
	});

	it("refuses a note that says nothing, because waking on it says nothing", () => {
		const { left, leave } = pad();

		expect(() => new Appointment().book(60, "   \n ", leave, NOW)).toThrow(/wakes you knowing/);
		expect(left).toEqual([]);
	});

	it("cancels a turn that never booked, without complaining about it", () => {
		const { left, leave } = pad();

		expect(new Appointment().cancel(leave).text).toContain("cancelled");
		expect(left).toEqual([{ cancel: true }]);
	});
});
