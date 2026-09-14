import { useCallback, useEffect, useState } from "react";
import { nameOf } from "./face.ts";
import type { Plane, Wake } from "./plane.ts";
import { Spin } from "./spin.tsx";

/**
 * Everything an agent is going to do, and the way to give it one more.
 *
 * An agent is not one errand on a timer. It is a thing that has a morning and an afternoon: read the
 * overnight mail at eight, sweep the deploys every ten minutes, write the week up on Friday. The
 * countdown in the rail says when the next of those lands and nothing about the other three, so this
 * is the list itself.
 *
 * Beside the triggers, which are its other half: a trigger answers "when something happens" and this
 * answers "when". It hung under the row in the rail behind a disclosure, and the disclosure stood
 * where the countdown and the spend are written — so reading either of those meant taking the mouse
 * off the row, and the thing you were reading disappeared as you reached for it.
 *
 * Whose each one is stays on the face of it. An agent that booked itself is doing something it
 * decided to keep doing, a line in the operator's file is not this plane's to take away, and one
 * typed here is the same person saying the same thing somewhere it can also be taken back.
 */
export function Tasks({
	plane,
	agentId,
	onChanged,
}: {
	plane: Plane;
	agentId: string;
	/** The rail shows the next one, and booking changes which that is. */
	onChanged: () => void;
}) {
	const [wakes, setWakes] = useState<readonly Wake[] | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	const [making, setMaking] = useState({ when: "", body: "" });
	const [busy, setBusy] = useState<string | undefined>();

	const read = useCallback((): void => {
		setWhy(undefined);
		plane.schedules(agentId).then(
			(all) => setWakes(all),
			(error: Error) => setWhy(error.message),
		);
	}, [plane, agentId]);

	useEffect(read, [read]);

	const run = async (what: string, act: () => Promise<void>): Promise<void> => {
		setBusy(what);
		setWhy(undefined);
		try {
			await act();
			// Asked again rather than patched here: what the plane has is the answer, and an agent
			// mid-turn may have booked another one while this was being read.
			read();
			onChanged();
		} catch (error) {
			setWhy((error as Error).message);
		} finally {
			setBusy(undefined);
		}
	};

	const ready = making.when.trim() !== "" && making.body.trim() !== "";

	return (
		<div className="card">
			<div className="card-body">
				<div>
					<h2 className="card-title">Tasks</h2>
					<p className="card-says">
						When {nameOf(agentId)} comes back on its own. A trigger answers when something happens;
						this answers when. What you write is what it is told at that moment, in your words.
					</p>
				</div>

				{why !== undefined && <p className="why">{why}</p>}

				{wakes === undefined ? (
					<p className="task-says flex items-center gap-2">
						<Spin /> reading its schedule…
					</p>
				) : wakes.length === 0 ? (
					<p className="task-says">Nothing booked. It waits to be spoken to.</p>
				) : (
					<div className="card-rows">
						{wakes.map((wake) => (
							<Booked
								key={wake.id}
								wake={wake}
								busy={busy === `off:${wake.id}`}
								onStop={() => void run(`off:${wake.id}`, () => plane.unschedule(agentId, wake.id))}
							/>
						))}
					</div>
				)}

				<form
					className="lines"
					onSubmit={(event) => {
						event.preventDefault();
						if (!ready) return;
						void run("book", async () => {
							await plane.schedule(agentId, making.when.trim(), making.body.trim());
							setMaking({ when: "", body: "" });
						});
					}}
				>
					<label className="ask-line">
						<span className="ask-name">When</span>
						<input
							className="field font-mono"
							value={making.when}
							placeholder="08:00"
							spellCheck={false}
							onChange={(event) => setMaking({ ...making, when: event.target.value })}
						/>
					</label>
					{/* What the plane takes, written where it is typed. The plane is the one that reads it,
					    so this list describes that reader rather than being a second one. */}
					<p className="ask-line">
						<span className="ask-name" />
						<span className="task-says flex-1">
							A time of day — <code className="md-code">08:00</code>, every day, in this browser's
							time zone. How often — <code className="md-code">every 10m</code>. Or once, after a
							wait — <code className="md-code">in 90m</code>. Five cron fields work too.
						</span>
					</p>
					<label className="ask-line">
						<span className="ask-name">Tell it</span>
						<input
							className="field"
							value={making.body}
							placeholder="Read the overnight mail and tell me what needs an answer."
							onChange={(event) => setMaking({ ...making, body: event.target.value })}
						/>
					</label>
				</form>
			</div>
			<div className="card-foot">
				<p>
					It answers where it answers everything else. An agent can book its own as well, and those
					say so.
				</p>
				<button
					type="button"
					className="pill"
					data-yes="true"
					disabled={!ready || busy === "book"}
					onClick={() => {
						if (!ready) return;
						void run("book", async () => {
							await plane.schedule(agentId, making.when.trim(), making.body.trim());
							setMaking({ when: "", body: "" });
						});
					}}
				>
					{busy === "book" && <Spin />}
					book it
				</button>
			</div>
		</div>
	);
}

function Booked({ wake, busy, onStop }: { wake: Wake; busy: boolean; onStop: () => void }) {
	// Clamped to a couple of lines, because most of them are a paragraph. The whole of it is a click
	// away, in place, rather than somewhere else that would have to be closed to get back here.
	const [whole, setWhole] = useState(false);
	// The file's are not this plane's to take away. Its own and yours are.
	const mine = wake.createdBy !== "operator";

	return (
		<div className="card-row">
			<div className="card-row-main">
				<span className="task-head">
					{said(wake)}
					<span className="task-whose">
						{wake.createdBy === "agent" ? "its own" : "yours"} · next {stamp(wake.nextRunAt)}
					</span>
				</span>
				<button
					type="button"
					className="task-body"
					data-whole={whole}
					onClick={() => setWhole(!whole)}
				>
					{wake.body}
				</button>
			</div>
			{mine ? (
				<button type="button" className="pill" data-no="true" disabled={busy} onClick={onStop}>
					{busy && <Spin />}
					call it off
				</button>
			) : (
				<span className="task-whose" title="Declared in this plane's configuration file">
					in your file
				</span>
			)}
		</div>
	);
}

/** What was asked for, rather than what it compiled to: `every 10m` reads, a cron field does not. */
function said(wake: Wake): string {
	if (wake.kind === "once") return `once · ${stamp(wake.nextRunAt)}`;
	const cron = wake.expression ?? "";
	const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
	if (daily?.[1] !== undefined && daily[2] !== undefined) {
		return `${daily[2].padStart(2, "0")}:${daily[1].padStart(2, "0")} daily`;
	}
	const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
	if (minutes?.[1] !== undefined) return `every ${minutes[1]}m`;
	const hours = /^0 \*\/(\d+) \* \* \*$/.exec(cron);
	if (hours?.[1] !== undefined) return `every ${hours[1]}h`;
	return cron;
}

/** The moment itself, because "30s" answers how long and not when. */
function stamp(iso: string): string {
	const when = new Date(iso);
	if (Number.isNaN(when.getTime())) return iso;
	const soon = when.getTime() - Date.now() < 12 * 60 * 60 * 1000;
	return when.toLocaleString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		...(soon ? {} : { month: "short", day: "numeric" }),
	});
}
