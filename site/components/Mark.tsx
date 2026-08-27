// The three figures of the favicon, drawn instead of fetched, so the brand takes the colour of the
// text beside it and turns green on hover along with it. The mask is the black gap the icon leaves
// around the middle figure: a copy of its body, widened sideways, punched out of the other two.
export function Mark() {
	return (
		<svg
			className="mark"
			viewBox="105.5 139.5 301 213.5"
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
		>
			<mask id="mark-gap">
				<rect x="105.5" y="139.5" width="301" height="213.5" fill="#fff" />
				<path d="M179 376V289a54 54 0 0 1 54-54h46a54 54 0 0 1 54 54v87Z" fill="#000" />
			</mask>
			<g mask="url(#mark-gap)">
				<circle cx="144" cy="204" r="32.6" />
				<path d="M105.5 353v-37.3a66.5 66.5 0 0 1 133 0V353Z" />
				<circle cx="368" cy="204" r="32.6" />
				<path d="M273.5 353v-37.3a66.5 66.5 0 0 1 133 0V353Z" />
			</g>
			<circle cx="256" cy="178.5" r="39" />
			<path d="M202 353v-64a54 54 0 0 1 108 0v64Z" />
		</svg>
	);
}
