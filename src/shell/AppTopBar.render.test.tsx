// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStore } from "../runtime/sessionStore";
import { AppTopBar } from "./AppTopBar";

// VU-008 / SRS_visual_ui §4.3: the app bar owns the session run control.
describe("AppTopBar", () => {
  let host: HTMLDivElement;
  let root: Root;
  const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(AppTopBar, { onToggleRail: vi.fn() })));
  });

  afterEach(async () => {
    if (sessionStore.getSnapshot().running) await act(async () => sessionStore.stop());
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders the nine-control inventory with a drag region (VU-008)", () => {
    expect(q("app-bar")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    for (const id of [
      "appbar-rail-toggle",
      "appbar-autosave-toggle",
      "appbar-session-title",
      "appbar-record-indicator",
      "appbar-record-switch",
      "appbar-run-btn",
      "appbar-minimize-btn",
      "appbar-maximize-btn",
      "appbar-close-btn",
    ]) {
      expect(q(id), id).not.toBeNull();
    }
  });

  it("starts and stops the shared session from the run control", async () => {
    sessionStore.setSourceKind("devgen");
    expect(q("appbar-run-btn")?.textContent).toMatch(/start/i);
    await act(async () => q("appbar-run-btn")?.click());
    expect(sessionStore.getSnapshot().running).toBe(true);
    expect(q("appbar-run-btn")?.textContent).toMatch(/stop/i);
    await act(async () => q("appbar-run-btn")?.click());
    expect(sessionStore.getSnapshot().running).toBe(false);
  });

  it("toggles autosave with an accessible label that states the next state", async () => {
    const button = q("appbar-autosave-toggle");
    expect(button?.getAttribute("aria-label")).toBe("Disable session autosave");
    await act(async () => button?.click());
    expect(q("appbar-autosave-toggle")?.getAttribute("aria-label")).toBe("Enable session autosave");
  });

  it("disables recording while a pcap replay is the source (§4.3 row 7)", async () => {
    await act(async () => sessionStore.setPcapSource("C:/tmp/replay.pcap"));
    const input = q("appbar-record-switch")?.querySelector("input");
    expect(input?.disabled).toBe(true);
    await act(async () => sessionStore.setSourceKind("devgen"));
    expect(q("appbar-record-switch")?.querySelector("input")?.disabled).toBe(false);
  });
});
