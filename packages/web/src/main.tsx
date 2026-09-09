import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("squad");
if (root === null) throw new Error("nothing to mount onto");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
