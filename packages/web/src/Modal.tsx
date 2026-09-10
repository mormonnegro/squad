import { useEffect, useRef } from "react";

/**
 * Something held open over everything else.
 *
 * One of these rather than one per screen, because a person learns how a modal behaves once: Escape
 * closes it, the dark behind it closes it, and what is inside scrolls without the page under it
 * moving. Three rules, in one place, and no screen gets to disagree with them.
 */
export function Modal({
	title,
	wide,
	children,
	onClose,
}: {
	title: string;
	/** For the ones that hold a decision rather than a paragraph. */
	wide?: boolean;
	children: React.ReactNode;
	onClose?: (() => void) | undefined;
}) {
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => box.current?.focus(), []);

	useEffect(() => {
		if (onClose === undefined) return;
		const key = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);

	return (
		<div className="scrim">
			{/* The way out for a mouse, as a layer behind the dialog rather than around it: around it,
			    every click inside would have to be stopped from reaching it, and stopping clicks is a
			    thing that goes wrong quietly. The way out for a keyboard is Escape, above. */}
			{onClose !== undefined && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard's way out
				// biome-ignore lint/a11y/noStaticElementInteractions: a backdrop is a way out, not a control
				<div className="scrim-back" onClick={onClose} />
			)}
			<div
				className="modal"
				data-wide={wide}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				ref={box}
				tabIndex={-1}
			>
				<header className="modal-head">
					<strong>{title}</strong>
					{onClose !== undefined && (
						<button type="button" className="key" onClick={onClose}>
							esc
						</button>
					)}
				</header>
				<div className="modal-body">{children}</div>
			</div>
		</div>
	);
}
