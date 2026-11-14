import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "./components/auth/AuthGate";
import "./readability.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found.");
createRoot(root).render(<AuthGate><App/></AuthGate>);
