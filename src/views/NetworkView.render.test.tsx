// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

const desktopMock = vi.hoisted(() => ({
  traceAnalyze: vi.fn(),
}));

vi.mock("../runtime/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/desktop")>();
  return {
    ...actual,
    traceAnalyze: desktopMock.traceAnalyze,
  };
});

import { analysisStore } from "../runtime/analysisStore";
import { sessionStore } from "../runtime/sessionStore";
import type { AnalysisReport } from "../runtime/desktop";
import { resumeView, suspendView } from "../shell/viewLifecycle";
import { NetworkView } from "./NetworkView";

const fixtureReport: AnalysisReport = {
  source: { kind: "ring" },
  generatedAtMs: new Date("2026-10-13T15:29:04Z").getTime(),
  overview: {
    frames: 4200,
    bytes: 512000,
    durationNs: 5_000_000_000,
    firstNs: 0,
    lastNs: 5_000_000_000,
    protocols: [{ protocol: "SOME/IP", frames: 3000, bytes: 360000, share: 0.714 }],
    endpoints: [
      {
        endpoint: "10.42.0.11",
        kind: "ipv4",
        framesSent: 1400,
        bytesSent: 168000,
        protocols: ["SOME/IP", "SD"],
      },
    ],
    conversations: [
      {
        a: "10.42.0.11",
        b: "10.42.0.21",
        transport: "UDP",
        frames: 1200,
        bytes: 144000,
        firstNs: 1_000_000,
        lastNs: 4_001_000_000,
      },
    ],
  },
  someip: {
    services: [
      {
        service: 0x1101,
        method: 0x8001,
        serviceName: "CameraObjects",
        methodName: "ObjectList",
        counts: {
          request: 0,
          requestNoReturn: 0,
          notification: 151,
          response: 0,
          error: 0,
        },
        senders: [
          {
            sender: "10.42.0.11",
            count: 151,
            period: {
              count: 150,
              meanNs: 33_000_000,
              minNs: 32_900_000,
              maxNs: 33_100_000,
              p50Ns: 33_000_000,
              p99Ns: 33_100_000,
              stddevNs: 50_000,
            },
            gaps: [],
            gapsTotal: 0,
          },
        ],
        latency: {
          count: 0,
          meanNs: 0,
          minNs: 0,
          maxNs: 0,
          p50Ns: 0,
          p99Ns: 0,
          stddevNs: 0,
        },
        unanswered: 0,
        errors: 0,
      },
    ],
  },
  sd: {
    instances: [
      {
        service: 0x1101,
        instance: 1,
        sender: "10.42.0.11",
        offers: 5,
        stopOffers: 0,
        firstNs: 0,
        lastNs: 4_000_000_000,
        period: {
          count: 4,
          meanNs: 1_000_000_000,
          minNs: 1_000_000_000,
          maxNs: 1_000_000_000,
          p50Ns: 1_000_000_000,
          p99Ns: 1_000_000_000,
          stddevNs: 0,
        },
        lastTtl: 3,
        reboots: 0,
      },
    ],
    eventgroups: [],
  },
  ptp: {
    senders: [
      {
        sender: "02:52:41:44:00:01",
        sync: 40,
        followUp: 40,
        pdelayReq: 10,
        pdelayResp: 10,
        announce: 1,
        syncPeriod: {
          count: 39,
          meanNs: 125_000_000,
          minNs: 124_900_000,
          maxNs: 125_100_000,
          p50Ns: 125_000_000,
          p99Ns: 125_100_000,
          stddevNs: 10_000,
        },
        grandmaster: "02:52:41:44:00:01",
      },
    ],
  },
  overflow: { keysDropped: 0 },
};

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
    desktopMock.traceAnalyze.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      await sessionStore.stop();
    });
    analysisStore.resetForTest();
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
    expect(container.querySelector('[data-testid="network-someip-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="network-someip-empty"]')).not.toBeNull();

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

  it("runs AN-008 analysis and renders snapshot tables", async () => {
    desktopMock.traceAnalyze.mockResolvedValueOnce(fixtureReport);
    const { container, root } = await renderNetwork();

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="network-analyze-btn"]',
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(desktopMock.traceAnalyze).toHaveBeenCalledWith({ kind: "ring" }, undefined);
    expect(container.querySelector('[data-testid="network-analysis-caption"]')?.textContent)
      .toMatch(/Snapshot of 4,200 frames · \d{2}:\d{2}:\d{2}/);
    expect(container.querySelector('[data-testid="network-endpoints-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="network-conversations-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="network-someip-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="network-someip-row-0x1101-0x8001"]'))
      .not.toBeNull();
    expect(container.querySelector('[data-testid="network-sd-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="network-ptp-table"]')).not.toBeNull();
    expect(container.textContent).toContain("33.0000 ms");
    expect(container.textContent).toContain("125.0000 ms");

    await act(async () => {
      suspendView("network");
      root.unmount();
    });
  });
});
