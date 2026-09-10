import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Class names, with the last word on a property winning.
 *
 * What shadcn's components are written against: a component sets its own padding and a caller
 * overrides it, and without this the two would both be in the attribute with the cascade deciding
 * by source order — which is not what the caller meant.
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
