type StorageMethods = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Privacy restrictions may reject the property access before a method is called. */
export function safeBrowserStorage(resolve: () => StorageMethods): StorageMethods {
  const fallback = new Map<string, string>();
  return {
    getItem(key) {
      try {
        const value = resolve().getItem(key);
        if (value === null) fallback.delete(key); else fallback.set(key, value);
        return value;
      } catch { return fallback.get(key) ?? null; }
    },
    setItem(key, value) {
      fallback.set(key, value);
      try { resolve().setItem(key, value); } catch { /* This page keeps the value. */ }
    },
    removeItem(key) {
      fallback.delete(key);
      try { resolve().removeItem(key); } catch { /* This page forgets the value. */ }
    },
  };
}

export const browserStorage = safeBrowserStorage(() => window.localStorage);
