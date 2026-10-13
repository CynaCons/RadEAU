// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { ExternalStore } from "../runtime/useStoreSelector";
import { useActiveStoreSelector } from "./useActiveStoreSelector";

interface Snapshot {
  running: boolean;
  stats: { received: number } | null;
}

class SessionLikeStore implements ExternalStore<Snapshot> {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { running: false, stats: null };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  publishStats(received: number) {
    this.snapshot = { ...this.snapshot, stats: { received } };
    for (const listener of this.listeners) listener();
  }
}

describe("useActiveStoreSelector", () => {
  it("does not re-render a component that does not display republished capture stats", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = new SessionLikeStore();
    let renders = 0;

    function Probe() {
      renders += 1;
      useActiveStoreSelector(true, store, (snapshot) => snapshot.running, false);
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => store.publishStats(1));
    await act(async () => store.publishStats(2));

    expect(renders).toBe(1);
    await act(async () => root.unmount());
  });
});
