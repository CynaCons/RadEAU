/**
 * Service-catalog store: mirrors catalog_model + catalog:state from the core.
 * Pushes the (serviceId, methodId) → name map into frameModel via
 * setCatalogNames. Browser mode stays unloaded forever (static SERVICES
 * fallback).
 */

import {
  catalogLoad,
  catalogUnload,
  fetchCatalogModel,
  onCatalogState,
  type CatalogModel,
  type CatalogService,
  type CatalogStateEvent,
} from "./desktop";
import {
  setCatalogNames,
  type CatalogNameEntry,
} from "./frameModel";

export type CatalogName = CatalogNameEntry;

export interface CatalogSnapshot {
  readonly loaded: boolean;
  readonly source: string;
  readonly serviceCount: number;
}

function nameKey(serviceId: number, methodId: number): string {
  return `${serviceId}:${methodId}`;
}

function buildNameMap(
  services: readonly CatalogService[],
): Map<string, CatalogNameEntry> {
  const map = new Map<string, CatalogNameEntry>();
  for (const svc of services) {
    for (const ev of svc.events) {
      map.set(nameKey(svc.serviceId, ev.eventId), {
        serviceName: svc.name,
        eventName: ev.name,
      });
    }
    for (const method of svc.methods) {
      map.set(nameKey(svc.serviceId, method.methodId), {
        serviceName: svc.name,
        eventName: method.name,
      });
    }
  }
  return map;
}

export class CatalogStore {
  private loaded = false;
  private source = "";
  private serviceCount = 0;
  private names = new Map<string, CatalogNameEntry>();
  private listeners = new Set<() => void>();
  private snapshot: CatalogSnapshot;
  /** Monotonic generation so overlapping fetches apply last-write-wins. */
  private refreshGen = 0;

  constructor() {
    this.snapshot = this.buildSnapshot();
    onCatalogState((state) => {
      this.applyState(state);
      if (state.loaded) void this.refreshModel();
      else this.clearModel();
    });
    // Startup fetch: desktop may already have the extract loaded; browser rejects.
    void this.refreshModel();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): CatalogSnapshot => this.snapshot;

  /** Catalog-first lookup for (serviceId, method-or-event id). */
  resolve = (serviceId: number, methodId: number): CatalogName | null => {
    if (!this.loaded) return null;
    return this.names.get(nameKey(serviceId, methodId)) ?? null;
  };

  isLoaded = (): boolean => this.loaded;

  /** Tooltip copy for the Trace rail catalog button. */
  railTooltip = (): string => {
    if (!this.loaded) return "Load service catalog";
    const src = this.source || "catalog";
    const n = this.serviceCount;
    return `${src} · ${n} service${n === 1 ? "" : "s"}`;
  };

  /** Aria / action label (distinct from the loaded-state tooltip). */
  railActionLabel = (): string =>
    this.loaded ? "Unload service catalog" : "Load service catalog";

  async load(): Promise<void> {
    try {
      await catalogLoad();
    } catch {
      // Browser / desktop-not-ready: stay unloaded.
    }
  }

  async unload(): Promise<void> {
    try {
      await catalogUnload();
    } catch {
      // Browser / desktop-not-ready: ignore.
    }
  }

  async toggle(): Promise<void> {
    if (this.loaded) await this.unload();
    else await this.load();
  }

  /**
   * Test seam: apply a model without going through the desktop bridge.
   * Clears when `model.loaded` is false.
   */
  applyModelForTest(model: CatalogModel): void {
    if (!model.loaded) {
      this.clearModel();
      return;
    }
    this.loaded = true;
    this.source = model.source;
    this.serviceCount = model.services.length;
    this.names = buildNameMap(model.services);
    setCatalogNames(this.names);
    this.publish();
  }

  /** Test seam: synthesize a catalog:state transition. */
  applyStateForTest(state: CatalogStateEvent): void {
    this.applyState(state);
    if (!state.loaded) this.clearModel();
  }

  private applyState(state: CatalogStateEvent): void {
    this.loaded = state.loaded;
    this.serviceCount = state.serviceCount;
    if (!state.loaded) this.source = "";
    this.publish();
  }

  private clearModel(): void {
    this.loaded = false;
    this.source = "";
    this.serviceCount = 0;
    this.names = new Map();
    setCatalogNames(null);
    this.publish();
  }

  private async refreshModel(): Promise<void> {
    const gen = ++this.refreshGen;
    try {
      const model = await fetchCatalogModel();
      if (gen !== this.refreshGen) return;
      if (!model.loaded) {
        this.clearModel();
        return;
      }
      this.loaded = true;
      this.source = model.source;
      this.serviceCount = model.services.length;
      this.names = buildNameMap(model.services);
      setCatalogNames(this.names);
      this.publish();
    } catch {
      // Browser / desktop-not-ready: stay unloaded (static fallback).
      if (gen !== this.refreshGen) return;
    }
  }

  private buildSnapshot(): CatalogSnapshot {
    return {
      loaded: this.loaded,
      source: this.source,
      serviceCount: this.serviceCount,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }
}

/** Application-wide catalog singleton. */
export const catalogStore = new CatalogStore();

export function resolveCatalogName(
  serviceId: number,
  methodId: number,
): CatalogName | null {
  return catalogStore.resolve(serviceId, methodId);
}

export function isCatalogLoaded(): boolean {
  return catalogStore.isLoaded();
}
