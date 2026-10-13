import { describe, expect, it } from "vitest";

import { automationStatusText } from "./automationClientsStore";

// AU-009: the Network view's Connection panel names the automation state.
describe("automationStatusText", () => {
  it("reads ready with no agent, then counts agents and the last method", () => {
    expect(automationStatusText({ count: 0, lastMethod: null })).toMatch(/ready/);
    expect(automationStatusText({ count: 1, lastMethod: "trace_query" })).toBe(
      "1 agent connected · last: trace_query",
    );
    expect(automationStatusText({ count: 2, lastMethod: null })).toBe("2 agents connected");
  });
});
