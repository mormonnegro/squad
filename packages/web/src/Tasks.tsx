import { useCallback, useEffect, useState } from "react";
import { nameOf } from "./face.ts";
import { Modal } from "./Modal.tsx";
import type { Plane, Wake } from "./plane.ts";
import { Spin } from "./spin.tsx";

/**
 * Everything an agent is going to do, and the way to give it one more.
 *
 * An agent is not one errand on a timer. It is a thing that has a morning and an afternoon: read the
 * overnight mail at eight, sweep the deploys every ten minutes, write the week up on Friday. The
 * countdown in the row says when the next of those lands and nothing about the other three, so this
 * is the list itself, hanging under the row it belongs to — open one agent and you are reading that
 * agent's week, not a schedule screen with a column of names to find it in again.
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
	/** Absent while the connection is coming back, when there is nobody to ask. */
	plane: Plane | undefined;
	agentId: string;
	/** The row above this shows the next one, and booking changes which that is. */
	onChanged: () => void;
}) {
	const [wakes, setWakes] = useState<readonly Wake[] | undefined>();
	const [why, setWhy] = useState<string | undefined>();
	const [adding, setAdding] = useState(false);

	const read = useCallback((): void => {
		if (plane === undefined) return;
		setWhy(undefined);
		plane.schedules(agentId).then(
			(all) => setWakes(all),
			(error: Error) => setWhy(error.message),
		);
	}, [plane, agentId]);

	useEffect(read, [read]);

	const stop = async (wake: Wake): Promise<void> => {
		if (plane === undefined) return;
		try {
			await plane.unschedule(agentId, wake.id);
			// Asked again rather than filtered here: what the plane has is the answer, and an agent
			// mid-turn may have booked another one while this was being read.
			read();
			onChanged();
		} catch (error) {
			setWhy((error as Error).message);
		}
	};

	return (
		<div className="tasks">
			{why !== undefined && <p className="task-says">{why}</p>}
			{wakes === undefined ? (
				<p className="task-says">reading its schedule…</p>
			) : wakes.length === 0 ? (
				<p className="task-says">Nothing booked. It waits to be spoken to.</p>
			) : (
				wakes.map((wake) => <Booked key={wake.id} wake={wake} onStop={() => void stop(wake)} />)
			)}
			<button
				type="button"
				className="task-add"
				disabled={plane === undefined}
				onClick={() => setAdding(true)}
			>
				＋ New task
			</button>

			{adding && plane !== undefined && (
				<NewTask
					plane={plane}
					agentId={agentId}
					onClose={() => setAdding(false)}
					onBooked={() => {
						setAdding(false);
						read();
						onChanged();
					}}
				/>
			)}
		</div>
	);
}

function Booked({ wake, onStop }: { wake: Wake; onStop: () => void }) {
	// Clamped to a couple of lines, because a rail is a rail. The whole of it is a click away, in
	// place, rather than somewhere else that would have to be closed again to get back here.
	const [whole, setWhole] = useState(false);
	// The file's are not this plane's to take away. Its own and yours are.
	const mine = wake.createdBy !== "operator";
	return (
		<div className="task">
			<div className="task-head">
				<span className="task-when">{said(wake)}</span>
				{mine ? (
					<button type="button" className="task-off" onClick={onStop} title="Call this one off">
						×
					</button>
				) : (
					<span className="task-whose" title="Declared in this plane's configuration file">
						in your file
					</span>
				)}
			</div>
			<button
				type="button"
				className="task-body"
				data-whole={whole}
				onClick={() => setWhole(!whole)}
			>
				{wake.body}
			</button>
			<span className="task-foot">
				{wake.createdBy === "agent" ? "its own" : "yours"} · next {stamp(wake.nextRunAt)}
			</span>
		</div>
	);
}

/**
 * When, and what to say then.
 *
 * Two fields, and the first one takes what a person would have said out loud. The plane is the one
 * that reads it — the shapes below are what it takes, written once here and parsed once there, so
 * that the list cannot come to disagree with the thing doing the work.
 */
function NewTask({
	plane,
	agentId,
	onClose,
	onBooked,
}: {
	plane: Plane;
	agentId: string;
	onClose: () => void;
	onBooked: () => void;
}) {
	const [when, setWhen] = useState("");
	const [body, setBody] = useState("");
	const [why, setWhy] = useState<string | undefined>();
	const [booking, setBooking] = useState(false);

	const book = async (): Promise<void> => {
		setBooking(true);
		setWhy(undefined);
		try {
			await plane.schedule(agentId, when.trim(), body.trim());
			onBooked();
		} catch (error) {
			setWhy((error as Error).message);
			setBooking(false);
		}
	};

	const ready = when.trim().length > 0 && body.trim().length > 0 && !booking;

	return (
		<Modal wide title={`One more turn for ${nameOf(agentId)}`} onClose={onClose}>
			<form
				className="flex flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (ready) void book();
				}}
			>
				<label className="flex flex-col gap-1.5">
					<span className="text-[0.78rem] text-muted">When</span>
					<input
						className="field font-mono"
						value={when}
						// biome-ignore lint/a11y/noAutofocus: a dialog with one first field, opened on purpose
						autoFocus
						placeholder="08:00"
						spellCheck={false}
						onChange={(event) => setWhen(event.target.value)}
					/>
					{/* What the plane takes, written where it is typed. The plane is the one that reads
					    it, so this list is a description of that reader and not a second one. */}
					<span className="text-[0.78rem] text-muted leading-relaxed">
						A time of day — <code className="md-code">08:00</code>, every day, in this browser's
						time zone. How often — <code className="md-code">every 10m</code>,{" "}
						<code className="md-code">every 2h</code>. Or once, after a wait —{" "}
						<code className="md-code">in 90m</code>, <code className="md-code">in 2d</code>. Five
						cron fields work too, if that is what you think in.
					</span>
				</label>
				<label className="flex flex-col gap-1.5">
					<span className="text-[0.78rem] text-muted">What to do</span>
					<textarea
						className="field leading-relaxed"
						rows={4}
						value={body}
						placeholder="Read the overnight mail and tell me what needs an answer."
						onChange={(event) => setBody(event.target.value)}
					/>
					<span className="text-[0.78rem] text-muted leading-relaxed">
						Said to the agent when the moment comes, the way you would have said it yourself. It
						answers where it answers everything else.
					</span>
				</label>
				{why !== undefined && <span className="why">{why}</span>}
				<div className="flex gap-2">
					<button type="submit" className="pill" data-yes="true" disabled={!ready}>
						{booking && <Spin />}
						{booking ? "booking…" : "book it"}
					</button>
					<button type="button" className="pill" onClick={onClose}>
						cancel
					</button>
				</div>
			</form>
		</Modal>
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
