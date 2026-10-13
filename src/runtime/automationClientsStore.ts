/**
 * Connected automation (agent) clients, from the core's `automation:clients`
 * event (SRS_automation AU-009). Read by the app-bar Agent chip and the
 * Network view's Connection panel.
 */

import { onAutomationClients, type AutomationClientsEvent } from "./desktop";

class AutomationClientsStore {
  private snapshot: AutomationClientsEvent = { count: 0, lastMethod: null };
  private listeners = new Set<() => void>();

  constructor() {
    onAutomationClients((state) => {
      this.snapshot = state;
      for (const cb of this.listeners) cb();
    });
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): AutomationClientsEvent => this.snapshot;
}

export const automationClientsStore = new AutomationClientsStore();

/** Connection-panel copy for the automation endpoint (AU-009). */
export function automationStatusText(state: AutomationClientsEvent): string {
  if (state.count <= 0) return "Automation ready — no agent connected (radeau-mcp)";
  const clients = state.count === 1 ? "1 agent connected" : `${state.count} agents connected`;
  return state.lastMethod ? `${clients} · last: ${state.lastMethod}` : clients;
}
