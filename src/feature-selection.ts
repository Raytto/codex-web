export type FeatureSelection = { paraBoard: boolean; revision: number };

export const DEFAULT_FEATURE_SELECTION: FeatureSelection = { paraBoard: false, revision: 0 };

export function isFeatureSelection(value: unknown): value is FeatureSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as Partial<FeatureSelection>;
  return typeof selection.paraBoard === "boolean" && Number.isSafeInteger(selection.revision) && selection.revision! >= 0;
}
