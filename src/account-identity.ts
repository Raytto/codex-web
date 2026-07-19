import type { Session } from "./api";

type AccountSession = Pick<Session, "displayName" | "username">;

export function resolveAccountIdentity(session: AccountSession): { displayName: string; initials: string } {
  const displayName = session.displayName?.trim() || session.username?.trim() || "用户";
  const words = displayName.split(/\s+/).filter(Boolean);
  const initials = (words.length > 1
    ? `${Array.from(words[0])[0] ?? ""}${Array.from(words.at(-1) ?? "")[0] ?? ""}`
    : Array.from(words[0] ?? "").slice(0, 2).join("")
  ).toLocaleUpperCase();
  return { displayName, initials: initials || "U" };
}
