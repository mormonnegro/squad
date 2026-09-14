import { describe, expect, it } from "vitest";
import { personOf } from "../src/avatar.tsx";

/** A fleet, so that what is being asked about is a list of faces rather than one. */
const FLEET = [
	"scout",
	"dev",
	"mcp",
	"probe",
	"casa",
	"bruno",
	"lucia",
	"tito",
	"mora",
	"juana",
	"pablo",
	"nube",
	"faro",
	"tero",
	"mate",
	"ceibo",
	"sur",
	"norte",
	"rio",
	"pampa",
	"deploy-watch",
	"news",
	"inbox-bot",
	"tesorero",
	"cocinero",
	"pepe",
	"ana",
	"zoe",
	"kiko",
	"lola",
	"nina",
	"otto",
];

/** How light a colour is. The same reading the drawing uses to keep hair off the colour of skin. */
function light(hex: string): number {
	const at = (from: number): number => Number.parseInt(hex.slice(from, from + 2), 16) / 255;
	return 0.299 * at(1) + 0.587 * at(3) + 0.114 * at(5);
}

describe("who a name turns out to be", () => {
	it("is the same person every time it is asked", () => {
		expect(personOf("scout")).toEqual(personOf("scout"));
	});

	it("is a different person from the one next to it", () => {
		expect(personOf("scout")).not.toEqual(personOf("scaut"));
	});

	/*
	 * The bug this is here for: the first version read six features out of the low bits of one hash,
	 * and FNV's low bits barely move for names this short — a third of the fleet came out with the
	 * same haircut, and the ones that shared it shared everything else too.
	 */
	it("does not give a third of a fleet the same haircut", () => {
		const tally = new Map<string, number>();
		for (const name of FLEET) {
			const cut = JSON.stringify(personOf(name).cut);
			tally.set(cut, (tally.get(cut) ?? 0) + 1);
		}
		expect(tally.size).toBeGreaterThan(6);
		expect(Math.max(...tally.values())).toBeLessThan(FLEET.length / 4);
	});

	it("uses the whole range of skin there is", () => {
		expect(new Set(FLEET.map((name) => personOf(name).skin)).size).toBe(6);
	});

	/** Fair hair on fair skin is a bald man with a halo, which is a face nothing ever chose. */
	it("never puts hair the colour of the skin under it", () => {
		for (const name of FLEET) {
			const person = personOf(name);
			expect(Math.abs(light(person.hair) - light(person.skin))).toBeGreaterThan(0.14);
		}
	});

	/** Bald is one of the faces, and it is one of them rather than a fifth of them. */
	it("keeps bald rare and keeps it", () => {
		const bald = FLEET.filter((name) => personOf(name).cut === undefined).length;
		expect(bald).toBeGreaterThan(0);
		expect(bald).toBeLessThan(FLEET.length / 5);
	});
});
