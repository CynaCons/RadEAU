import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AUTOMATION_EMPTY } from "../runtime/automationDisplay";
import { SIM_EMPTY } from "../runtime/simulationDisplay";
import { AutomationView } from "./AutomationView";
import { SimulationView } from "./SimulationView";

describe("SimulationView honesty (v0.1.6)", () => {
  it("keeps the secondary rail and shows the signal empty state by default", () => {
    const html = renderToStaticMarkup(<SimulationView />);
    expect(html).toContain('data-testid="simulation-rail"');
    expect(html).toContain('data-testid="simulation-nav-node"');
    expect(html).toContain('data-testid="simulation-nav-signal"');
    expect(html).toContain('data-testid="simulation-nav-frame-gen"');
    expect(html).toContain('data-testid="simulation-nav-presets"');
    expect(html).toContain('data-testid="simulation-signal-empty"');
    expect(html).toContain(SIM_EMPTY.signal);
    expect(html).not.toContain("VehicleSpeed");
    expect(html).not.toContain("simulation-signal-vehicle-speed-slider");
  });
});

describe("AutomationView honesty (v0.1.6)", () => {
  it("renders the empty script list and an empty console with no fabricated output", () => {
    const html = renderToStaticMarkup(<AutomationView />);
    expect(html).toContain('data-testid="automation-script-list"');
    expect(html).toContain('data-testid="automation-empty"');
    expect(html).toContain(AUTOMATION_EMPTY);
    expect(html).toContain('data-testid="automation-console"');
    expect(html).toContain('data-testid="automation-console-clear-btn"');
    expect(html).not.toContain("sd_monitor_soak.py");
    expect(html).not.toContain("automation-run-btn");
    expect(html).not.toContain("automation-stop-btn");
    expect(html).not.toContain("automation-delete-btn");
    expect(html).not.toContain("fusion-baseline");
  });
});
