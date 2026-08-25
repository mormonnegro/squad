import { useEffect, useRef, useState } from "react";

/** Copies, and says so for a moment. Shared so every command on the page copies the same way. */
export function useCopy(text: string): { done: boolean; copy: () => void } {
	const [done, setDone] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	async function run() {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return;
		}
		setDone(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setDone(false), 1600);
	}

	return {
		done,
		copy: () => {
			void run();
		},
	};
}
