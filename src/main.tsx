import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyThemePreference, readStoredThemePreference } from "./theme";
import "./styles.css";

applyThemePreference(readStoredThemePreference());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
