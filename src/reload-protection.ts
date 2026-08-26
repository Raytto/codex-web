export type DeferredInstanceReloadState = {
  voiceActive: boolean;
  submitting: boolean;
  conversationId: string | null;
  editingPending: boolean;
  input: string;
  quoteExcerpt: string;
  looseFileCount: number;
  uploadCount: number;
  draftLoaded: boolean;
  currentDraftSignature: string;
  syncedDraftSignature: string | undefined;
};

export function canApplyDeferredInstanceReload(state: DeferredInstanceReloadState): boolean {
  if (state.voiceActive || state.submitting) return false;
  const hasEphemeralInput = Boolean(
    state.input
    || state.quoteExcerpt
    || state.looseFileCount
    || state.uploadCount,
  );
  if (!hasEphemeralInput) return true;
  if (!state.conversationId || state.editingPending || state.looseFileCount || state.uploadCount || !state.draftLoaded) return false;
  return state.currentDraftSignature === state.syncedDraftSignature;
}
