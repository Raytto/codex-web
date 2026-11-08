import { instance } from "./instance";
document.documentElement.dataset.brandTheme = instance.theme;
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installMobileViewportRecovery } from "./mobile-viewport";
import { applyThemePreference, readStoredThemePreference } from "./theme";
import "./styles.css";

document.documentElement.dataset.brandTheme = instance.theme;
applyThemePreference(readStoredThemePreference());
installMobileViewportRecovery();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
