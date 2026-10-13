// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { sessionStore } from "../runtime/sessionStore";
import { resumeView, suspendView } from "../shell/viewLifecycle";
import { NetworkView } from "./NetworkView";

async function renderNetwork() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    resumeView("network");
    root.render(createElement(NetworkView));
  });
  return { container, root };
}

describe("NetworkView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      await sessionStore.stop();
    });
    vi.restoreAllMocks();
  });

  it("renders honest empty states (NV-004) and updates stats when devgen runs", async () => {
    const { container, root } = await renderNetwork();

    // The Connection panel shows the current source and link state from sessionStore
    expect(container.querySelector('[data-testid="network-connection-panel"]')).not.toBeNull();
    const sourceKind = container.querySelector('[data-testid="network-source-kind"]');
    expect(sourceKind).not.toBeNull();
    expect(sourceKind?.textContent).toBeTruthy();

    // Topology / SD monitor / PTP panels show honest empty states (NV-004)
    expect(container.querySelector('[data-testid="network-topology-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="network-topology-empty"]')).not.toBeNull();

    expect(container.querySelector('[data-testid="network-sd-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="network-sd-empty"]')).not.toBeNull();

    expect(container.querySelector('[data-testid="network-ptp-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="network-ptp-empty"]')).not.toBeNull();

    // Ensure stats are not present yet
    expect(container.querySelector('[data-testid="network-stat-received"]')).toBeNull();

    // Start session
    await act(async () => {
      await sessionStore.start();
    });

    // Advance time for stats (MIRROR_STATS_MS is 1000)
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });

    // live counters update when a devgen session runs
    const received = container.querySelector('[data-testid="network-stat-received"]');
    expect(received).not.toBeNull();
    expect(received?.textContent).toMatch(/Received/);

    const emitted = container.querySelector('[data-testid="network-stat-emitted"]');
    expect(emitted).not.toBeNull();
    expect(emitted?.textContent).toMatch(/Emitted/);

    await act(async () => {
      suspendView("network");
      root.unmount();
    });
  });
});
