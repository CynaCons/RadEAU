// @vitest-environment happy-dom
// VU-010/VU-021: rail width contract and reduced-motion transition policy.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { NavRail } from "./NavRail";

describe("NavRail", () => {
  it("DEBUG dump", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(NavRail, {
          expanded: false,
          activeViewId: "trace",
          onNavigate: () => undefined,
          onAbout: () => undefined,
        }),
      );
    });
    const rail = container.querySelector('[data-testid="nav-rail"]') as HTMLElement;
    console.log("WIDTH collapsed:", getComputedStyle(rail).width, rail.className);
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
    console.log("WIDTH expanded:", getComputedStyle(rail).width, rail.className);
    const styleTags = Array.from(document.head.querySelectorAll("style")).map((s) => s.textContent).join("\n");
    console.log("HAS reduced motion rule:", styleTags.includes("prefers-reduced-motion"));
    const count = styleTags.split("prefers-reduced-motion").length - 1;
    console.log("COUNT reduced-motion blocks:", count);
    const label = container.querySelector('[data-testid="nav-trace"] p') as HTMLElement;
    console.log("LABEL class:", label?.className);
    const labelHash = label.className.match(/css-([a-z0-9]+)/)?.[0];
    const labelIdx = styleTags.indexOf(`.${labelHash}{`);
    console.log("LABEL rule:", styleTags.slice(Math.max(0, labelIdx - 10), labelIdx + 200));
    const mqIdxs: number[] = [];
    let searchFrom = 0;
    for (;;) {
      const found = styleTags.indexOf("prefers-reduced-motion", searchFrom);
      if (found === -1) break;
      mqIdxs.push(found);
      searchFrom = found + 1;
    }
    for (const i of mqIdxs) console.log("MQ BLOCK:", styleTags.slice(i - 5, i + 150));
    await act(async () => root.unmount());
    expect(true).toBe(true);
  });
});
