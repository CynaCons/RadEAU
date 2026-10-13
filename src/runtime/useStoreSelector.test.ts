// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { shallowEqual, useStoreSelector, type ExternalStore } from "./useStoreSelector";

class Store<S> implements ExternalStore<S> {
  private listeners = new Set<() => void>();
  constructor(private snap: S) {}
  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = () => this.snap;
  set(next: S) {
    this.snap = next;
    for (const cb of this.listeners) cb();
  }
}

describe("shallowEqual", () => {
  it("compares own keys by identity", () => {
    expect(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({ a: [] }, { a: [] })).toBe(false);
    expect(shallowEqual(null, null)).toBe(true);
  });
});

describe("useStoreSelector", () => {
  it("re-renders only when the selected slice changes", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = new Store({ running: false, stats: 0 });
    let renders = 0;
    let seen: boolean | null = null;
    function Probe() {
      renders += 1;
      seen = useStoreSelector(store, (s) => s.running);
      return null;
    }
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () => root.render(createElement(Probe)));
    expect(renders).toBe(1);
    await act(async () => store.set({ running: false, stats: 1 }));
    await act(async () => store.set({ running: false, stats: 2 }));
    expect(renders).toBe(1);
    await act(async () => store.set({ running: true, stats: 3 }));
    expect(renders).toBe(2);
    expect(seen).toBe(true);
    await act(async () => root.unmount());
  });

  it("keeps an object selection stable under shallowEqual", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = new Store({ a: 1, b: 2, tick: 0 });
    let renders = 0;
    function Probe() {
      renders += 1;
      useStoreSelector(store, (s) => ({ a: s.a, b: s.b }), shallowEqual);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => store.set({ a: 1, b: 2, tick: 1 }));
    expect(renders).toBe(1);
    await act(async () => store.set({ a: 1, b: 3, tick: 2 }));
    expect(renders).toBe(2);
    await act(async () => root.unmount());
  });

  it("freezes while inactive and catches up once on reactivation", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = new Store({ running: false, stats: 0 });
    let renders = 0;
    let active = true;
    let seen = false;
    function Probe() {
      renders += 1;
      seen = useStoreSelector(store, (s) => s.running, Object.is, active);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => store.set({ running: false, stats: 1 }));
    expect(renders).toBe(1);
    active = false;
    await act(async () => root.render(createElement(Probe)));
    const inactiveRenders = renders;
    await act(async () => store.set({ running: true, stats: 2 }));
    expect(renders).toBe(inactiveRenders);
    expect(seen).toBe(false);
    active = true;
    await act(async () => root.render(createElement(Probe)));
    expect(renders).toBe(inactiveRenders + 1);
    expect(seen).toBe(true);
    await act(async () => root.unmount());
  });

  it("recomputes when the selector changes without a store publish (review R4b-2)", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = new Store({ a: 1, b: 2 });
    let seen = 0;
    function Probe({ field }: { field: "a" | "b" }) {
      seen = useStoreSelector(store, (s) => s[field]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe, { field: "a" })));
    expect(seen).toBe(1);
    await act(async () => root.render(createElement(Probe, { field: "b" })));
    expect(seen).toBe(2);
    await act(async () => root.unmount());
  });
});
