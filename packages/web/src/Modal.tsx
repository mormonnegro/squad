import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

/**
 * Something held open over everything else.
 *
 * One of these rather than one per screen, because a person learns how a dialog behaves once. What
 * it is now is Radix underneath: focus is trapped and handed back, the page stops scrolling, and the
 * tree is portalled out of whatever column would have clipped it — four things the hand-written one
 * did not do and would have been forty lines of getting nearly right.
 *
 * Kept as this wrapper rather than used directly at every call site so that what a dialog is stays
 * one decision. The screens below it say what they hold; none of them says how a dialog works.
 */
export function Modal({
	title,
	wide,
	size,
	children,
	onClose,
}: {
	title: string;
	/** For the ones that hold a decision rather than a paragraph. */
	wide?: boolean;
	/** Where `wide` is not enough: a row of things to choose between wants more than a decision. */
	size?: "narrow" | "wide" | "wider";
	children: React.ReactNode;
	onClose?: (() => void) | undefined;
}) {
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				// Every way out arrives here — Escape, the corner, a click on the dark behind it — and
				// whether there is one is the caller's to say. The first question of all, where the
				// agents live, passes no `onClose`, because it has no answer that is "never mind".
				if (!open) onClose?.();
			}}
		>
			<DialogContent
				wide={wide}
				size={size}
				// Escape is the way out, and only where there is one to take.
				onEscapeKeyDown={(event) => {
					if (onClose === undefined) event.preventDefault();
				}}
			>
				<DialogHeader closable={onClose !== undefined}>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				<DialogBody>{children}</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
