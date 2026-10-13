// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TraceFrame } from "../runtime/frameModel";
import { useStoreSelector, type ExternalStore } from "../runtime/useStoreSelector";

const { countRender } = vi.hoisted(() => ({ countRender: vi.fn() }));
vi.mock("../runtime/perfProbe", () => ({ countRender }));

import { MemoTraceRowCells, type TraceTableContext } from "./TraceView";

class ToolbarStore implements ExternalStore<{ label: string }> {
  private listeners = new Set<() => void>();
  private snapshot = { label: "Stopped" };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): { label: string } => this.snapshot;

  setLabel(label: string): void {
    this.snapshot = { label };
    for (const listener of this.listeners) listener();
  }
}

const frame = {
  id: 1,
  tS: 0.25,
  time: "0.2500",
  dir: "rx",
  source: "Camera",
  sourceTitle: "Camera (10.42.0.11)",
  protocol: "SOME/IP",
  serviceMethod: "0x1101:0x8001",
  name: "Objects",
  type: "Notification",
  session: "—",
  length: "64",
  payload: "de ad",
  deltaGlobal: "—",
  deltaKey: "—",
  channel: "Dev generator",
  key: "someip:4353:32769",
  proto: 0,
  sv: 0x1101,
  m: 0x8001,
  srcEp: 0,
  ty: 2,
  se: -1,
  sa: 0x0a2a000b,
  da: 0x0a2a0014,
  sm: 0x02004200000b,
  vl: -1,
} as TraceFrame;

const context: TraceTableContext = {
  columns: [],
  rows: { length: 1, get: () => frame },
  mode: "sequential",
  pinned: new Set(),
  expansion: null,
  timeMode: "session",
  sessionEpochMs: null,
  onTogglePin: () => undefined,
  onToggleExpand: () => undefined,
};

describe("Trace row render discipline", () => {
  it("does not re-render a row for a toolbar-only store change", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = new ToolbarStore();

    function Harness() {
      const label = useStoreSelector(store, (snapshot) => snapshot.label);
      return createElement(
        "table",
        null,
        createElement(
          "tbody",
          null,
          createElement("tr", { "data-toolbar-label": label },
            createElement(MemoTraceRowCells, { f: frame, context }),
          ),
        ),
      );
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Harness)));
    expect(countRender).toHaveBeenCalledTimes(1);

    await act(async () => store.setLabel("Running"));
    expect(countRender).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });
});
