import type { Project } from "./api";

export const LEGACY_SELECTED_PROJECT_KEY = "cww:selected-project";
export const LEGACY_SELECTED_CONVERSATION_KEY = "codex-web:selected-conversation";

export type SelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type AccountSelectionStorageKeys = { project: string; conversation: string };

export function accountSelectionStorageKeys(accountId: string): AccountSelectionStorageKeys {
  if (!accountId.trim()) throw new Error("账号标识不能为空。");
  const scope = encodeURIComponent(accountId);
  return {
    project: `cww:account:${scope}:selected-project`,
    conversation: `cww:account:${scope}:selected-conversation`,
  };
}

export function readStoredSelection(storage: SelectionStorage, key: string): string | null {
  try {
    const value = storage.getItem(key)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeStoredSelection(storage: SelectionStorage, key: string, value: string | null): void {
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch {
    // Browser privacy settings may disable storage; in-memory selection still works.
  }
}

export function clearLegacySelectionStorage(storage: SelectionStorage): void {
  try {
    storage.removeItem(LEGACY_SELECTED_PROJECT_KEY);
    storage.removeItem(LEGACY_SELECTED_CONVERSATION_KEY);
  } catch {
    // A legacy value cannot be safely assigned to an account, so never migrate it.
  }
}

export function chooseSelectedProject(savedId: string | null, projects: Project[], defaultProjectId: string | null): string | null {
  if (savedId && projects.some((project) => project.id === savedId)) return savedId;
  if (defaultProjectId && projects.some((project) => project.id === defaultProjectId)) return defaultProjectId;
  return projects[0]?.id ?? null;
}
