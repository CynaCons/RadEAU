// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TraceFilterPopover } from "./TraceFilterPopover";

const options = [
  { key: "a", label: "Alpha", count: 1 },
  { key: "b", label: "Beta", count: 2 },
  { key: "c", label: "Gamma", count: 3 },
];

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TraceFilterPopover", () => {
  let root: Root;
  let container: HTMLDivElement;
  let anchorEl: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    anchorEl = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(anchorEl);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.removeChild(container);
    document.body.removeChild(anchorEl);
    document.body.innerHTML = ""; // clean up portals
  });

  it("renders search, filters options, updates counts, handles apply/cancel/select-all (SRS_visual_ui §5.2, TR-007)", async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(
        createElement(TraceFilterPopover, {
          open: true,
          anchorEl,
          column: "service",
          options,
          committed: null,
          onApply,
          onCancel,
        })
      );
    });

    const popover = document.body.querySelector('[data-testid="trace-filter-popover"]');
    expect(popover).toBeTruthy();

    const count = document.body.querySelector('[data-testid="trace-filter-count"]');
    expect(count?.textContent).toBe("3 / 3");

    const optionA = document.body.querySelector('[data-testid="trace-filter-option-a"] input[type="checkbox"]') as HTMLInputElement;
    expect(optionA.checked).toBe(true);

    await act(async () => {
      optionA.click();
    });

    expect(count?.textContent).toBe("2 / 3");

    const searchInput = document.body.querySelector('[data-testid="trace-filter-search"] input') as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    await act(async () => {
      setInputValue(searchInput, "bet");
    });

    expect(document.body.querySelector('[data-testid="trace-filter-option-a"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="trace-filter-option-b"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="trace-filter-option-c"]')).toBeNull();

    await act(async () => {
      setInputValue(searchInput, "");
    });
    expect(document.body.querySelector('[data-testid="trace-filter-option-a"]')).toBeTruthy();

    const selectAllBtn = document.body.querySelector('[data-testid="trace-filter-select-all"]') as HTMLButtonElement;
    expect(selectAllBtn.textContent).toBe("Select all");

    await act(async () => {
      selectAllBtn.click();
    });
    expect(count?.textContent).toBe("3 / 3");
    expect(selectAllBtn.textContent).toBe("Deselect all");

    await act(async () => {
      selectAllBtn.click();
    });
    expect(count?.textContent).toBe("0 / 3");

    const applyBtn = document.body.querySelector('[data-testid="trace-filter-apply"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });
    expect(onApply).toHaveBeenCalledWith(new Set());
    onApply.mockClear();

    await act(async () => {
      selectAllBtn.click();
    });
    expect(count?.textContent).toBe("3 / 3");

    await act(async () => {
      applyBtn.click();
    });
    expect(onApply).toHaveBeenCalledWith(null);

    const cancelBtn = document.body.querySelector('[data-testid="trace-filter-cancel"]') as HTMLButtonElement;
    await act(async () => {
      cancelBtn.click();
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it("omits search field for protocol/dir columns (SRS_visual_ui §5.2, TR-007)", async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(
        createElement(TraceFilterPopover, {
          open: true,
          anchorEl,
          column: "dir",
          options,
          committed: new Set(["a", "b"]),
          onApply,
          onCancel,
        })
      );
    });

    const popover = document.body.querySelector('[data-testid="trace-filter-popover"]');
    expect(popover).toBeTruthy();

    const searchInput = document.body.querySelector('[data-testid="trace-filter-search"]');
    expect(searchInput).toBeNull();

    const count = document.body.querySelector('[data-testid="trace-filter-count"]');
    expect(count?.textContent).toBe("2 / 3");
  });
});