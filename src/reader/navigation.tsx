import type { MouseEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { BASE_PATH } from "../api";

// Ordinary links keep native same-tab navigation and Ctrl/Cmd/middle-click.
// Alt-click is an explicit new-tab shortcut instead of a browser download.
export function handleReaderLinkClick(event: MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0 || !event.altKey) return;
  event.preventDefault();
  window.open(event.currentTarget.href, "_blank", "noopener,noreferrer");
}

export function ReaderBackLink() {
  function goBack(event: MouseEvent<HTMLAnchorElement>) {
    handleReaderLinkClick(event);
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // Only traverse a known in-app history entry. Direct links and new tabs
    // still have a useful destination when there is no page to return to.
    if (window.history.length > 1 && document.referrer) {
      const previous = new URL(document.referrer);
      const previousInApp = !BASE_PATH || previous.pathname === BASE_PATH || previous.pathname.startsWith(`${BASE_PATH}/`);
      if (previous.origin === window.location.origin && previousInApp && previous.href !== window.location.href) {
        event.preventDefault();
        window.history.back();
      }
    }
  }
  return <a className="file-preview-back" href={BASE_PATH || "/"} onClick={goBack} title="返回工作站" aria-label="返回工作站"><ArrowLeft size={18} /></a>;
}
