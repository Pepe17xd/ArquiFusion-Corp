import { createRoot } from "react-dom/client";
import App from "./App";
import { Landing } from "./Landing";
import { AuthGate } from "./components/auth/AuthGate";
import "./readability.css";
import "./design-system.css";
import "./premium-v2.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found.");
createRoot(root).render(window.location.pathname === "/" ? <Landing/> : <AuthGate><App/></AuthGate>);
