import { useEffect } from "react";

const APP_TITLE = "Codex Web";

/** The mounted page owns the tab title; leaving it clears any private context. */
export function usePageTitle(title?: string | null): void {
  const label = title?.replace(/\s+/g, " ").trim();
  useEffect(() => {
    document.title = label ? `${label} - ${APP_TITLE}` : APP_TITLE;
    return () => { document.title = APP_TITLE; };
  }, [label]);
}
