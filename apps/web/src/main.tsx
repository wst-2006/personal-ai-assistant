import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./ink-growth-system.css";
import "./focus-mini.css";
import "./focus-themes.css";
import "./settings-workspace.css";
import "./review-radar.css";
import { App } from "./App";
import { FocusMiniWindow } from "./FocusMiniWindow";

const isFocusMiniWindow = new URLSearchParams(window.location.search).get("focus-mini") === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isFocusMiniWindow ? <FocusMiniWindow /> : <App />}
  </StrictMode>
);
