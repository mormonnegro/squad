/** @type {import('next').NextConfig} */
export default {
	// Static export, so the site is a directory of files any host can serve and the project never
	// needs a second machine running to explain itself.
	output: "export",
	trailingSlash: true,
	images: { unoptimized: true },
	reactStrictMode: true,
};
