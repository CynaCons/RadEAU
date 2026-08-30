/**
 * Service-catalog store: mirrors catalog_model + catalog:state from the core.
 * Pushes the (serviceId, methodId) → name map into frameModel via
 * setCatalogNames. Browser mode stays unloaded forever (static SERVICES
 * fallback). Import/reload/decode actions surface honest errors; never fakes
 * a catalog.
 */

import {
  catalogDiagnostics,
  catalogImport,
  catalogLoad,
  catalogReload,
  catalogUnload,
  fetchCatalogModel,
  onCatalogState,
  pickArxmlFile,
  type CatalogDiagnostic,
  type CatalogModel,
  type CatalogService,
  type CatalogSourceKind,
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
  readonly sourceKind: CatalogSourceKind | "";
  readonly serviceCount: number;
  readonly signalCount: number;
  readonly errors: number;
  readonly warnings: number;
  readonly lastError: string | null;
  readonly diagnostics: readonly CatalogDiagnostic[];
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

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export class CatalogStore {
  private loaded = false;
  private source = "";
  private sourceKind: CatalogSourceKind | "" = "";
  private serviceCount = 0;
  private signalCount = 0;
  private errors = 0;
  private warnings = 0;
  private lastError: string | null = null;
  private diagnostics: CatalogDiagnostic[] = [];
  private names = new Map<string, CatalogNameEntry>();
  private listeners = new Set<() => void>();
  private snapshot: CatalogSnapshot;
  /** Monotonic generation so overlapping fetches apply last-write-wins. */
  private refreshGen = 0;
  private diagGen = 0;

  constructor() {
    this.snapshot = this.buildSnapshot();
    onCatalogState((state) => {
      this.applyState(state);
      if (state.loaded) void this.refreshModel();
      else this.clearNamesOnly();
      void this.maybeFetchDiagnostics();
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
    if (!this.loaded) return "Service catalog";
    const src =
      this.sourceKind === "embedded"
        ? "embedded demo catalog"
        : this.source || "catalog";
    const n = this.serviceCount;
    return `${src} · ${n} service${n === 1 ? "" : "s"}`;
  };

  /** Aria / action label for the rail button (opens the catalog popover). */
  railActionLabel = (): string => "Service catalog";

  /** Decode switch: enable decoding without discarding the parsed model. */
  async load(): Promise<void> {
    try {
      await catalogLoad();
    } catch (err) {
      this.setLastError(errMessage(err));
    }
  }

  async unload(): Promise<void> {
    try {
      await catalogUnload();
    } catch (err) {
      this.setLastError(errMessage(err));
    }
  }

  /** Former rail toggle — now the Decode switch. */
  async toggleDecode(): Promise<void> {
    if (this.loaded) await this.unload();
    else await this.load();
  }

  /** @deprecated Prefer toggleDecode; kept for older call sites. */
  async toggle(): Promise<void> {
    await this.toggleDecode();
  }

  /**
   * Opens the ARXML file dialog and imports. On cancel does nothing. On
   * rejection keeps the previous catalog and surfaces lastError.
   */
  async importArxml(): Promise<void> {
    let path: string | null;
    try {
      path = await pickArxmlFile();
    } catch (err) {
      this.setLastError(errMessage(err));
      return;
    }
    if (path === null) return;
    try {
      const summary = await catalogImport(path);
      this.lastError = null;
      this.diagnostics = summary.diagnostics.slice();
      this.source = summary.source;
      this.serviceCount = summary.services;
      this.signalCount = summary.signals;
      this.errors = summary.diagnostics.filter((d) => d.severity === "error").length;
      this.warnings = summary.diagnostics.filter((d) => d.severity === "warn").length;
      this.publish();
      // catalog:state from the core refreshes names + authoritative counts.
      void this.refreshModel();
    } catch (err) {
      this.setLastError(errMessage(err));
    }
  }

  /** Re-imports the current source; no-op surface for embedded (UI disables). */
  async reload(): Promise<void> {
    if (this.sourceKind === "embedded") return;
    try {
      const summary = await catalogReload();
      this.lastError = null;
      this.diagnostics = summary.diagnostics.slice();
      this.source = summary.source;
      this.serviceCount = summary.services;
      this.signalCount = summary.signals;
      this.errors = summary.diagnostics.filter((d) => d.severity === "error").length;
      this.warnings = summary.diagnostics.filter((d) => d.severity === "warn").length;
      this.publish();
      void this.refreshModel();
    } catch (err) {
      this.setLastError(errMessage(err));
    }
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
    this.sourceKind = this.sourceKind || "file";
    this.serviceCount = model.services.length;
    this.names = buildNameMap(model.services);
    setCatalogNames(this.names);
    this.publish();
  }

  /** Test seam: synthesize a catalog:state transition. */
  applyStateForTest(state: CatalogStateEvent): void {
    this.applyState(state);
    if (!state.loaded) this.clearNamesOnly();
    void this.maybeFetchDiagnostics();
  }

  /** Test seam: inject diagnostics without a desktop round-trip. */
  setDiagnosticsForTest(diags: readonly CatalogDiagnostic[]): void {
    this.diagnostics = diags.slice();
    this.publish();
  }

  private setLastError(message: string): void {
    this.lastError = message || "catalog operation failed";
    this.publish();
  }

  private applyState(state: CatalogStateEvent): void {
    this.loaded = state.loaded;
    this.serviceCount = state.serviceCount;
    this.signalCount = state.signalCount;
    this.source = state.source;
    this.sourceKind = state.sourceKind;
    this.errors = state.errors;
    this.warnings = state.warnings;
    this.lastError = state.lastError;
    if (state.errors + state.warnings === 0) {
      this.diagnostics = [];
    }
    this.publish();
  }

  /** Unload decode without inventing a "cleared" source — names go, state stays. */
  private clearNamesOnly(): void {
    this.names = new Map();
    setCatalogNames(null);
    this.publish();
  }

  private clearModel(): void {
    this.loaded = false;
    this.source = "";
    this.sourceKind = "";
    this.serviceCount = 0;
    this.signalCount = 0;
    this.errors = 0;
    this.warnings = 0;
    this.lastError = null;
    this.diagnostics = [];
    this.names = new Map();
    setCatalogNames(null);
    this.publish();
  }

  private async maybeFetchDiagnostics(): Promise<void> {
    if (this.errors + this.warnings <= 0) return;
    const gen = ++this.diagGen;
    try {
      const diags = await catalogDiagnostics();
      if (gen !== this.diagGen) return;
      this.diagnostics = diags;
      this.publish();
    } catch {
      // Browser / command not ready: leave the list empty; counts still show.
      if (gen !== this.diagGen) return;
    }
  }

  private async refreshModel(): Promise<void> {
    const gen = ++this.refreshGen;
    try {
      const model = await fetchCatalogModel();
      if (gen !== this.refreshGen) return;
      if (!model.loaded) {
        this.loaded = false;
        this.names = new Map();
        setCatalogNames(null);
        this.publish();
        return;
      }
      this.loaded = true;
      this.source = model.source || this.source;
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
      sourceKind: this.sourceKind,
      serviceCount: this.serviceCount,
      signalCount: this.signalCount,
      errors: this.errors,
      warnings: this.warnings,
      lastError: this.lastError,
      diagnostics: this.diagnostics,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }
}

/** Application-wide catalog singleton. */
export const catalogStore = new CatalogStore();
