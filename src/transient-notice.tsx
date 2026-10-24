import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

export const NOTICE_LIFETIME_MS = 10_000;

// A repeated action with identical text is a new notice and gets its own lifetime.
export function useNoticeState(): [string, Dispatch<SetStateAction<string>>, number] {
  const [notice, setNotice] = useState({ text: "", revision: 0 });
  const setText = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    setNotice(current => {
      const text = typeof action === "function" ? action(current.text) : action;
      if (typeof action === "function" && text === current.text) return current;
      return { text, revision: current.revision + 1 };
    });
  }, []);
  return [notice.text, setText, notice.revision];
}

export function TransientNotice({ message, revision, onDismiss, className, children, role = "status" }: {
  message: string; revision?: string | number; onDismiss: () => void;
  className: string; children: ReactNode; role?: "status" | "alert";
}) {
  const current = useRef({ message, revision, onDismiss });
  current.current = { message, revision, onDismiss };
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // A queued timer from the preceding render must not dismiss a replacement
      // message or a different conversation before effect cleanup runs.
      if (current.current.message === message && current.current.revision === revision) current.current.onDismiss();
    }, NOTICE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [message, revision]);
  return <div className={className} role={role}>{children}</div>;
}
