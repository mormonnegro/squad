import { VIEWPORT } from "./browser.ts";

/**
 * The page the operator gets: a picture of the browser, and a button that says who is driving.
 *
 * Every frame is a JPEG in a multipart stream and the `<img>` decodes it — no player, no socket, no
 * library. That is not minimalism for its own sake: this page is reached through a tunnel made of a
 * `docker exec`, and every layer that could get confused in there is a layer that turns "the login
 * screen is blank" into an afternoon.
 *
 * What is deliberately not here is any way to drive the browser without saying so first. The button
 * exists because two hands on one keyboard is the failure this whole feature has to avoid, and a
 * page where clicking just works would be one an operator uses by accident, in the middle of a turn,
 * while the agent is three clicks into something.
 */
export function viewPage(agentId: string): string {
	return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${agentId} — screen</title>
<style>
	:root { color-scheme: dark; }
	body {
		margin: 0;
		background: #0b0c0e;
		color: #e6e6e6;
		font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
		display: flex;
		flex-direction: column;
		height: 100vh;
	}
	header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		border-bottom: 1px solid #23262b;
		background: #121418;
	}
	form { flex: 1; display: flex; gap: 8px; min-width: 0; }
	input {
		flex: 1;
		min-width: 0;
		font: inherit;
		padding: 6px 10px;
		border-radius: 6px;
		border: 1px solid #2f343b;
		background: #0e1116;
		color: #e6e6e6;
	}
	input:disabled { color: #7b828b; }
	.who { font-weight: 600; }
	.state { color: #9aa3ad; }
	.state[data-holder="operator"] { color: #6ee7a8; }
	.note {
		color: #ffd27f;
		max-width: 28ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	button {
		font: inherit;
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid #2f343b;
		background: #1b1f25;
		color: #e6e6e6;
		cursor: pointer;
	}
	button:hover { background: #242a31; }
	button[data-holding="yes"] { background: #1f4634; border-color: #2f6b4f; }
	main { flex: 1; display: grid; place-items: center; overflow: auto; padding: 14px; }
	.frame { position: relative; line-height: 0; }
	img { max-width: 100%; border-radius: 8px; border: 1px solid #23262b; }
	.veil {
		position: absolute;
		inset: 0;
		border-radius: 8px;
		background: rgba(8, 9, 11, 0.45);
		display: grid;
		place-items: center;
		color: #c9d1d9;
		font-size: 13px;
		letter-spacing: 0.01em;
	}
	.veil[hidden] { display: none; }
</style>
<header>
	<span class="who">${agentId}</span>
	<span class="state" id="state">the agent is driving</span>
	<form id="go">
		<input id="url" placeholder="Take the keyboard to go somewhere" spellcheck="false" disabled>
	</form>
	<span class="note" id="note"></span>
	<button id="keyboard">Take the keyboard</button>
</header>
<main>
	<div class="frame">
		<img id="screen" src="frames" width="${VIEWPORT.width}" height="${VIEWPORT.height}" alt="">
		<div class="veil" id="veil">the agent is driving — take the keyboard to touch this page</div>
	</div>
</main>
<script>
(function () {
	var screen = document.getElementById("screen");
	var veil = document.getElementById("veil");
	var label = document.getElementById("state");
	var note = document.getElementById("note");
	var button = document.getElementById("keyboard");
	var address = document.getElementById("url");
	var go = document.getElementById("go");
	var holding = false;

	function show(state) {
		holding = state.holder === "operator";
		label.textContent = holding ? "you have the keyboard" : "the agent is driving";
		label.dataset.holder = state.holder;
		note.textContent = state.note ? "the agent asks: " + state.note : "";
		button.textContent = holding ? "Give it back" : "Take the keyboard";
		button.dataset.holding = holding ? "yes" : "no";
		veil.hidden = holding;
		address.disabled = !holding;
		address.placeholder = holding ? "Where to?" : "Take the keyboard to go somewhere";
		// Never while it is being typed into. The state is polled every couple of seconds, and an
		// address bar that rewrote itself mid-URL would be one nobody could finish typing in.
		if (document.activeElement !== address && state.url) address.value = state.url;
	}

	function post(path, body) {
		return fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body || {})
		}).then(function (r) { return r.json(); });
	}

	button.addEventListener("click", function () {
		post("keyboard", { hold: !holding }).then(show);
	});

	go.addEventListener("submit", function (event) {
		event.preventDefault();
		if (!holding) return;
		var typed = address.value.trim();
		if (typed === "") return;
		// What a person types into an address bar is a hostname about as often as it is a URL, and
		// the screen only opens http and https — so the scheme is added rather than refused.
		if (!/^https?:///i.test(typed)) typed = "https://" + typed;
		address.blur();
		// A refusal goes where the agent's notes go rather than into a dialog: a modal in here would
		// block every later request from this page, which is the one failure this view cannot recover
		// from on its own.
		post("open", { url: typed }).then(function (answer) {
			if (answer && answer.refused) note.textContent = answer.refused;
		});
	});

	// Where the pointer is on the page, not on the picture of it: the frame is drawn at whatever
	// width the window allows, and a click sent unscaled lands somewhere else entirely.
	function at(event) {
		var box = screen.getBoundingClientRect();
		var scale = screen.naturalWidth ? screen.naturalWidth / box.width : 1;
		return { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
	}

	screen.addEventListener("mousedown", function (event) {
		if (!holding) return;
		event.preventDefault();
		var point = at(event);
		post("input", { kind: "down", x: point.x, y: point.y });
	});
	screen.addEventListener("mouseup", function (event) {
		if (!holding) return;
		event.preventDefault();
		var point = at(event);
		post("input", { kind: "up", x: point.x, y: point.y });
	});
	screen.addEventListener("wheel", function (event) {
		if (!holding) return;
		event.preventDefault();
		var point = at(event);
		post("input", { kind: "wheel", x: point.x, y: point.y, deltaY: event.deltaY });
	}, { passive: false });

	// On the window rather than the image, because an image is not focusable and a person who has
	// taken the keyboard expects to be able to type without clicking something first.
	window.addEventListener("keydown", function (event) {
		if (!holding) return;
		// Typing in the address bar is typing here, not on the page.
		if (document.activeElement === address) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "F5" || event.key === "F12") return;
		// A modifier on its own is a key the page never needed to be told about, and sending it is one
		// request per press of Shift — which, for somebody typing a password, is most of them.
		if (["Shift", "Control", "Alt", "Meta", "CapsLock"].indexOf(event.key) !== -1) return;
		event.preventDefault();
		post("input", { kind: "key", key: event.key });
	});

	setInterval(function () {
		fetch("state").then(function (r) { return r.json(); }).then(show).catch(function () {});
	}, 2000);
	fetch("state").then(function (r) { return r.json(); }).then(show).catch(function () {});
})();
</script>`;
}
