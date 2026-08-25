import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * True once the element has been scrolled to, and true from then on.
 *
 * The consoles are two thirds of the way down the page, so an animation that ran on load would be
 * over before anyone saw it. Without an observer — or without scripts, which the stylesheet answers
 * for — the content is simply there.
 */
export function useReveal<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
	const ref = useRef<T>(null);
	const [shown, setShown] = useState(false);

	useEffect(() => {
		const element = ref.current;
		if (element === null) return;
		if (typeof IntersectionObserver !== "function") {
			setShown(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setShown(true);
				observer.disconnect();
			},
			{ rootMargin: "0px 0px -12% 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return [ref, shown];
}
