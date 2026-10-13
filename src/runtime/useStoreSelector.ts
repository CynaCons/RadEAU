/**
 * Selector subscription over the app's external stores: a component
 * re-renders only when the slice it reads changes, not on every publish of
 * the whole snapshot (a stats tick must not re-render views that never show
 * stats).
 */

import { useRef, useSyncExternalStore } from "react";

export interface ExternalStore<S> {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => S;
}

/** Shallow equality over own enumerable keys (objects) or Object.is. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (
      !Object.prototype.hasOwnProperty.call(b, k) ||
      !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Returns `selector(store.getSnapshot())`, stable across publishes for which
 * `isEqual(previous, next)` holds. The selector may be an inline closure: the
 * latest one is used, and the cached result is reused while the snapshot is
 * the same object.
 */
export function useStoreSelector<S, T>(
  store: ExternalStore<S>,
  selector: (snapshot: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cache = useRef<{ snap: S; value: T } | null>(null);

  const getSelection = (): T => {
    const snap = store.getSnapshot();
    const prev = cache.current;
    if (prev !== null && prev.snap === snap) return prev.value;
    const next = selectorRef.current(snap);
    if (prev !== null && isEqual(prev.value, next)) {
      prev.snap = snap;
      return prev.value;
    }
    cache.current = { snap, value: next };
    return next;
  };

  return useSyncExternalStore(store.subscribe, getSelection);
}
