// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { ViewHost } from "./ViewHost";
import { useViewActive } from "./viewLifecycle";
import { VIEWS } from "./viewRegistry";

const settle = () =>
  act(async () => {
    // ViewHost resumes/suspends after paint: two animation frames + a timeout.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

// D4 keep-alive: every view mounts once; only the active one is displayed and resumed.
describe("ViewHost", () => {
  it("mounts every view once, shows only the active one, and moves resume on navigation", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const first = VIEWS[0]!.id;
    const second = VIEWS[1]!.id;
    const seen: Record<string, boolean> = {};
    function Watch({ id }: { id: string }) {
      seen[id] = useViewActive(id);
      return null;
    }
    const render = (active: string) =>
      root.render(
        createElement("div", null, [
          createElement(ViewHost, { key: "host", activeViewId: active }),
          createElement(Watch, { key: "a", id: first }),
          createElement(Watch, { key: "b", id: second }),
        ]),
      );

    await act(async () => render(first));
    await settle();
    for (const view of VIEWS) {
      const box = host.querySelector<HTMLElement>(`[data-testid="view-${view.id}"]`);
      expect(box, view.id).not.toBeNull();
      expect(box?.style.display === "none" || getComputedStyle(box!).display === "none").toBe(view.id !== first);
    }
    expect(seen[first]).toBe(true);
    expect(seen[second]).toBe(false);

    await act(async () => render(second));
    await settle();
    expect(seen[first]).toBe(false);
    expect(seen[second]).toBe(true);
    expect(host.querySelectorAll('[data-testid^="view-"]').length).toBeGreaterThanOrEqual(VIEWS.length);

    await act(async () => root.unmount());
    host.remove();
    // Renders every view (MUI-heavy) — slow under a parallel full-suite run.
  }, 20_000);
});
