import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

/**
 * A dialog, on Radix.
 *
 * The shape shadcn ships, with four things this project's own modal never had and could not fake
 * cheaply: focus is trapped inside and given back to whatever opened it, the page underneath stops
 * scrolling, the tree is portalled out of a column that clips, and everything a screen reader needs
 * to call it a dialog is on it.
 *
 * Styled from the palette the terminal console and the site already use — `raised`, `line`, `muted`
 * are ours, not Tailwind's greys. What is borrowed here is behaviour, not a look.
 */
export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;

export function DialogOverlay({ className, ...rest }: Primitive.DialogOverlayProps) {
	return (
		<Primitive.Overlay
			className={cn(
				"fixed inset-0 z-40 bg-black/65",
				"data-[state=open]:animate-in data-[state=closed]:animate-out",
				"data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
				className,
			)}
			{...rest}
		/>
	);
}

export function DialogContent({
	className,
	children,
	wide,
	...rest
}: Primitive.DialogContentProps & { wide?: boolean | undefined }) {
	return (
		<Primitive.Portal>
			<DialogOverlay />
			<Primitive.Content
				className={cn(
					"fixed top-1/2 left-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col",
					"overflow-hidden rounded-[10px] border border-line bg-raised text-say shadow-[0_16px_50px_#000d]",
					"font-sans text-[0.88rem]/[1.6] outline-none",
					wide ? "w-[min(42rem,calc(100vw-3rem))]" : "w-[min(34rem,calc(100vw-3rem))]",
					wide ? "max-h-[86vh]" : "max-h-[min(32rem,82vh)]",
					className,
				)}
				// A click an inch wide of a dialog is a click that missed, not an answer: these hold a
				// form half typed and a button that stops something. Escape and the corner are the ways
				// out, and both are things a person did on purpose.
				onPointerDownOutside={(event) => event.preventDefault()}
				onInteractOutside={(event) => event.preventDefault()}
				{...rest}
			>
				{children}
			</Primitive.Content>
		</Primitive.Portal>
	);
}

/** The head stays where the way out is, and the body scrolls under it. */
export function DialogHeader({ children }: { children: React.ReactNode }) {
	return (
		<header className="flex flex-none items-center justify-between gap-4 border-b border-line px-6 py-[1.1rem] text-[1.05rem] text-said">
			{children}
			<Primitive.Close
				className="rounded border border-line bg-sunk px-2 py-1 font-mono text-[0.8rem] text-muted hover:border-muted hover:text-said"
				aria-label="Close"
			>
				<X className="size-3.5" />
			</Primitive.Close>
		</header>
	);
}

export function DialogTitle({ children }: { children: React.ReactNode }) {
	return <Primitive.Title className="font-semibold">{children}</Primitive.Title>;
}

export function DialogDescription({ children }: { children: React.ReactNode }) {
	return <Primitive.Description className="sr-only">{children}</Primitive.Description>;
}

/**
 * The rhythm, still three steps.
 *
 * Written as Tailwind now rather than as a custom property, and the same three: what goes together,
 * what follows, and what changes the subject.
 */
export function DialogBody({ children }: { children: React.ReactNode }) {
	return <div className="flex min-h-0 flex-col gap-6 overflow-y-auto p-6">{children}</div>;
}
