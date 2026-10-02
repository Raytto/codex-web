import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { DEFAULT_FEATURE_SELECTION, isFeatureSelection, type FeatureSelection } from "./feature-selection";

const FeatureSelectionContext = createContext({
  features: DEFAULT_FEATURE_SELECTION,
  saving: false,
  error: "",
  applyFeatures: (_value: FeatureSelection) => {},
  changeParaBoard: async (_enabled: boolean) => {},
});

async function boundedRequest<T>(run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  parent?.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(abort, 12_000);
  try { return await run(controller.signal); }
  finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); }
}

export const useFeatureSelection = () => useContext(FeatureSelectionContext);

export function FeatureSelectionProvider({ initial, children }: { initial?: FeatureSelection; children: ReactNode }) {
  const [features, setFeatures] = useState(initial ?? DEFAULT_FEATURE_SELECTION);
  const current = useRef(features);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const applyFeatures = useCallback((value: FeatureSelection) => {
    // A late read or write receipt must never undo a newer server event.
    if (!isFeatureSelection(value) || value.revision < current.current.revision) return;
    current.current = value;
    setFeatures(value);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const value = await boundedRequest(api.featureSelection, signal);
    if (!signal?.aborted) applyFeatures(value);
  }, [applyFeatures]);

  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const reconcile = async () => {
      if (busy || document.hidden || controller.signal.aborted) return;
      busy = true;
      try { await refresh(controller.signal); } catch { /* Reconnect/focus and the next poll retry. */ }
      finally { busy = false; }
    };
    void reconcile();
    const interval = window.setInterval(() => void reconcile(), 30_000);
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [refresh]);

  const changeParaBoard = async (paraBoard: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try { const revision = current.current.revision; applyFeatures(await boundedRequest(signal => api.updateFeatureSelection({ paraBoard, revision }, signal))); }
    catch (e) {
      setError(e instanceof DOMException && e.name === "AbortError" ? "保存超时，请检查网络后重试。" : e instanceof Error ? e.message : "保存失败，请重试。");
      // Also resolves a lost write response and a concurrent device change.
      try { await refresh(); } catch { /* Keep the last confirmed value. */ }
    } finally { savingRef.current = false; setSaving(false); }
  };
  return <FeatureSelectionContext.Provider value={{ features, saving, error, applyFeatures, changeParaBoard }}>{children}</FeatureSelectionContext.Provider>;
}
