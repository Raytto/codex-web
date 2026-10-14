export type FeatureSelection = { paraBoard: boolean; opportunityCards?: boolean; revision: number };

export const DEFAULT_FEATURE_SELECTION: FeatureSelection = { paraBoard: false, opportunityCards: false, revision: 0 };

export function isFeatureSelection(value: unknown): value is FeatureSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as Partial<FeatureSelection>;
  return typeof selection.paraBoard === "boolean" && (selection.opportunityCards === undefined || typeof selection.opportunityCards === "boolean") && Number.isSafeInteger(selection.revision) && selection.revision! >= 0;
}
