import NextDocument, { type DocumentContext, Head, Html, Main, NextScript } from "next/document";
import { langOf } from "../lib/lang";

export default function Document({ lang }: { lang: string }) {
	return (
		<Html lang={lang}>
			<Head>
				<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
				<link rel="icon" href="/icon.png" type="image/png" sizes="512x512" />
				<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
			</Head>
			<body>
				<Main />
				<NextScript />
			</body>
		</Html>
	);
}

// Which language the page is in, written into the markup rather than set from a script: it is what a
// screen reader picks a voice from and what a browser offers to translate against, and both of them
// have decided before any script of ours has run. The export renders this once per page, so the
// route is known here.
Document.getInitialProps = async (ctx: DocumentContext) => ({
	...(await NextDocument.getInitialProps(ctx)),
	lang: langOf(ctx.pathname),
});
