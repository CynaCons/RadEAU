// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  registerViewLifecycle,
  resumeView,
  suspendView,
  useViewActive,
  useViewLifecycle,
} from "./viewLifecycle";

// PRD §3.6 / D4 keep-alive contract; VU-027 hidden views do zero work.
describe("view lifecycle", () => {
  it("calls resume and suspend once per transition", () => {
    const onResume = vi.fn();
    const onSuspend = vi.fn();
    const unregister = registerViewLifecycle("lc-a", { onResume, onSuspend });
    resumeView("lc-a");
    resumeView("lc-a");
    expect(onResume).toHaveBeenCalledTimes(1);
    suspendView("lc-a");
    suspendView("lc-a");
    expect(onSuspend).toHaveBeenCalledTimes(1);
    unregister();
    resumeView("lc-a");
    expect(onResume).toHaveBeenCalledTimes(1);
    suspendView("lc-a");
  });

  it("re-renders a useViewActive consumer only on its own transitions", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let renders = 0;
    let active: boolean | null = null;
    const lifecycle = {};
    function Probe() {
      renders += 1;
      useViewLifecycle("lc-b", lifecycle);
      active = useViewActive("lc-b");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    expect(active).toBe(false);
    await act(async () => resumeView("lc-b"));
    expect(active).toBe(true);
    const afterResume = renders;
    await act(async () => resumeView("lc-other"));
    expect(renders).toBe(afterResume);
    await act(async () => suspendView("lc-b"));
    expect(active).toBe(false);
    await act(async () => {
      suspendView("lc-other");
      root.unmount();
    });
  });
});
