import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

type Scope = string | null;
type ScopedSetter<T> = Dispatch<SetStateAction<T>> & {
  for: (scope: Scope, value: SetStateAction<T>) => void;
  get: (scope: Scope) => T;
  entries: () => IterableIterator<[Scope, T]>;
};

/** Async callbacks keep the scope in which they started, even after navigation. */
export function useConversationState<T>(scope: Scope, initial: T): [T, ScopedSetter<T>] {
  const values = useRef(new Map<Scope, T>());
  const initialRef = useRef(initial);
  const [, render] = useState(0);
  const get = useCallback((key: Scope) => values.current.has(key) ? values.current.get(key)! : initialRef.current, []);
  const setFor = useCallback((key: Scope, update: SetStateAction<T>) => {
    const previous = get(key);
    const next = typeof update === "function" ? (update as (value: T) => T)(previous) : update;
    if (Object.is(previous, next)) return;
    values.current.set(key, next);
    render((version) => version + 1);
  }, [get]);
  const set = useMemo(() => Object.assign((update: SetStateAction<T>) => setFor(scope, update), {
    for: setFor, get, entries: () => values.current.entries(),
  }), [get, scope, setFor]);
  return [get(scope), set];
}
