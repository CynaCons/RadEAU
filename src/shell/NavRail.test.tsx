// @vitest-environment happy-dom
// VU-010/VU-020/VU-021: rail width contract and permitted/reduced-motion transition policy.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { NavRail } from "./NavRail";

async function renderNavRail(expanded: boolean) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(NavRail, {
        expanded,
        activeViewId: "trace",
        onNavigate: () => undefined,
        onAbout: () => undefined,
      }),
    );
  });
  return { container, root };
}

describe("NavRail", () => {
  it("sizes the collapsed and expanded rail while keeping labels accessible (VU-010)", async () => {
    const { container, root } = await renderNavRail(false);
    const rail = container.querySelector('[data-testid="nav-rail"]') as HTMLElement;
    const trace = container.querySelector('[data-testid="nav-trace"]') as HTMLElement;
    const label = trace.querySelector("p") as HTMLElement;

    expect(getComputedStyle(rail).width).toBe("65px");
    expect(trace.getAttribute("aria-label")).toBe("Trace");
    expect(getComputedStyle(label).opacity).toBe("0");

    await act(async () => {
      root.render(
        createElement(NavRail, {
          expanded: true,
          activeViewId: "trace",
          onNavigate: () => undefined,
          onAbout: () => undefined,
        }),
      );
    });
    expect(getComputedStyle(rail).width).toBe("240px");
    expect(getComputedStyle(label).opacity).toBe("1");
    await act(async () => root.unmount());
  });

  it("keeps rail motion limited and reduced-motion-safe (VU-020, VU-021)", async () => {
    const { root } = await renderNavRail(false);
    const styleTags = Array.from(document.head.querySelectorAll("style")).map((s) => s.textContent).join("\n");

    expect(styleTags).toContain("transition:width 225ms cubic-bezier(0.4, 0, 0.6, 1)");
    expect(styleTags).toContain("transition:opacity 225ms cubic-bezier(0.4, 0, 0.6, 1)");
    expect(styleTags).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styleTags.match(/transition:none/g)?.length).toBeGreaterThanOrEqual(2);

    await act(async () => root.unmount());
  });
});
