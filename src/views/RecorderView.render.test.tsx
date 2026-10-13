// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { traceStore } from "../runtime/traceStore";
import { resumeView, suspendView } from "../shell/viewLifecycle";
import { RecorderView } from "./RecorderView";

async function renderRecorder() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    resumeView("recorder");
    root.render(createElement(RecorderView));
  });
  return { container, root };
}

describe("RecorderView", () => {
  it("renders main controls, honest empty states, and handles export disabled state (CP-014)", async () => {
    traceStore.clear(); // Ensure trace store is empty

    const { container, root } = await renderRecorder();

    // Check main panels
    expect(container.querySelector('[data-testid="recorder-record-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recorder-replay-panel"]')).not.toBeNull();

    // Check main controls
    expect(container.querySelector('[data-testid="recorder-arm-switch"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recorder-dir"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recorder-dir-browse"]')).not.toBeNull();
    
    // Check honest empty state for recording list
    const emptyState = container.querySelector('[data-testid="recorder-empty"]');
    expect(emptyState).not.toBeNull();
    
    // Check export button when traceStore is empty
    const exportBtn = container.querySelector('[data-testid="recorder-export-btn"]') as HTMLButtonElement;
    expect(exportBtn).not.toBeNull();
    expect(exportBtn.disabled).toBe(true);
    
    expect(exportBtn.parentElement?.getAttribute("aria-label")).toBe("no frames buffered");

    await act(async () => {
      suspendView("recorder");
      root.unmount();
    });
  });
});
