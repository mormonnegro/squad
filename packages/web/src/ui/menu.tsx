import * as Primitive from "@radix-ui/react-dropdown-menu";
import { cn } from "../lib/utils.ts";

/**
 * A menu that hangs off something.
 *
 * Radix for the same reasons the dialog is: arrow keys walk it, Escape leaves it, the focus goes
 * back where it came from, and it is portalled out of the column it hangs in — which in this
 * application is a column that scrolls and clips, so a hand-written one was going to be cut off the
 * first time the list got long.
 *
 * Lighter than what it sits on, with a border and a shadow under it. A menu the colour of the
 * surface behind it is a menu whose edges a person has to find by moving the mouse.
 */
export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;

export function MenuContent({ className, children, ...rest }: Primitive.DropdownMenuContentProps) {
	return (
		<Primitive.Portal>
			<Primitive.Content
				sideOffset={6}
				align="start"
				className={cn(
					"z-50 min-w-[15rem] overflow-hidden rounded-[10px] border border-[#2b3037] bg-[#171b20]",
					"font-sans text-[0.85rem] text-say shadow-[0_14px_40px_#000c]",
					"data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
					className,
				)}
				{...rest}
			>
				{children}
			</Primitive.Content>
		</Primitive.Portal>
	);
}

/** What the menu is about, before what it offers: the thing you are already on. */
export function MenuHeader({ children }: { children: React.ReactNode }) {
	return <div className="border-b border-[#2b3037] px-3 py-3">{children}</div>;
}

export function MenuGroup({ children }: { children: React.ReactNode }) {
	return <div className="p-1">{children}</div>;
}

export function MenuSeparator() {
	return <Primitive.Separator className="h-px bg-[#2b3037]" />;
}

export function MenuItem({ className, children, ...rest }: Primitive.DropdownMenuItemProps) {
	return (
		<Primitive.Item
			className={cn(
				"flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 outline-none",
				"data-[highlighted]:bg-white/10 data-[highlighted]:text-said",
				className,
			)}
			{...rest}
		>
			{children}
		</Primitive.Item>
	);
}

/** A square with a letter in it, which is how a thing with no picture gets one. */
export function MenuTile({ children, accent }: { children: React.ReactNode; accent?: string }) {
	return (
		<span
			className="grid size-7 flex-none place-items-center rounded-md border border-[#2b3037] bg-sunk font-mono text-[0.72rem]"
			style={accent === undefined ? undefined : { color: `var(--color-${accent})` }}
		>
			{children}
		</span>
	);
}
