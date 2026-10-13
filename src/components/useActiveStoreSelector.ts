import type { ExternalStore } from "../runtime/useStoreSelector";
import { useStoreSelector } from "../runtime/useStoreSelector";

const INACTIVE = Symbol("inactive-store");
const inactiveStore: ExternalStore<typeof INACTIVE> = {
  subscribe: () => () => undefined,
  getSnapshot: () => INACTIVE,
};

/** Detaches a screen-only subscription while its keep-alive view is hidden. */
export function useActiveStoreSelector<S, T>(
  active: boolean,
  store: ExternalStore<S>,
  selector: (snapshot: S) => T,
  inactiveValue: T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectedStore = active
    ? (store as ExternalStore<S | typeof INACTIVE>)
    : (inactiveStore as ExternalStore<S | typeof INACTIVE>);

  return useStoreSelector(
    selectedStore,
    (snapshot) => (snapshot === INACTIVE ? inactiveValue : selector(snapshot as S)),
    isEqual,
  );
}
