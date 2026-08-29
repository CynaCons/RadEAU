import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCatalogNames, resolveSomeIpName, setCatalogNames } from "./frameModel";
import type { CatalogDiagnostic, CatalogStateEvent } from "./desktop";

vi.mock("./desktop", () => {
  let stateCb: ((s: CatalogStateEvent) => void) | null = null;
  let model: {
    loaded: boolean;
    source: string;
    services: {
      serviceId: number;
      name: string;
      instanceId: number;
      events: { eventId: number; name: string; signals: never[] }[];
      methods: { methodId: number; name: string }[];
    }[];
  } = { loaded: false, source: "", services: [] };
  let rejectModel = false;
  let diagnostics: CatalogDiagnostic[] = [];
  let importReject: string | null = null;

  const emitState = (partial: Partial<CatalogStateEvent>) => {
    const state: CatalogStateEvent = {
      loaded: model.loaded,
      serviceCount: model.services.length,
      signalCount: 0,
      source: model.source,
      sourceKind: "file",
      errors: 0,
      warnings: 0,
      lastError: null,
      ...partial,
    };
    stateCb?.(state);
  };

  return {
    fetchCatalogModel: vi.fn(async () => {
      if (rejectModel) throw new Error("desktop app only");
      return model;
    }),
    catalogLoad: vi.fn(async () => {
      model = {
        loaded: true,
        source: "catalog/sensor-fusion.arxml",
        services: [
          {
            serviceId: 0x1101,
            name: "CameraObjects",
            instanceId: 1,
            events: [{ eventId: 0x8001, name: "ObjectList", signals: [] }],
            methods: [],
          },
          {
            serviceId: 0x1201,
            name: "FusedObjects",
            instanceId: 1,
            events: [
              { eventId: 0x8001, name: "FusedTrackList", signals: [] },
              { eventId: 0x8002, name: "FusionStats", signals: [] },
            ],
            methods: [{ methodId: 1, name: "SetFusionMode" }],
          },
        ],
      };
      emitState({
        loaded: true,
        serviceCount: model.services.length,
        signalCount: 3,
        source: model.source,
        sourceKind: "embedded",
      });
    }),
    catalogUnload: vi.fn(async () => {
      model = { ...model, loaded: false };
      emitState({
        loaded: false,
        serviceCount: model.services.length,
        signalCount: 3,
        source: model.source,
        sourceKind: "embedded",
      });
    }),
    catalogImport: vi.fn(async (path: string) => {
      if (importReject) throw new Error(importReject);
      model = {
        loaded: true,
        source: path,
        services: [
          {
            serviceId: 0x1101,
            name: "CameraObjects",
            instanceId: 1,
            events: [{ eventId: 0x8001, name: "ObjectList", signals: [] }],
            methods: [],
          },
        ],
      };
      diagnostics = [
        { severity: "warn", path: "/Pkg/Signal", message: "skipped FIELD" },
      ];
      emitState({
        loaded: true,
        serviceCount: 1,
        signalCount: 2,
        source: path,
        sourceKind: "file",
        errors: 0,
        warnings: 1,
        lastError: null,
      });
      return {
        source: path,
        services: 1,
        signals: 2,
        diagnostics,
      };
    }),
    catalogReload: vi.fn(async () => {
      if (importReject) throw new Error(importReject);
      return {
        source: model.source,
        services: model.services.length,
        signals: 2,
        diagnostics: [],
      };
    }),
    catalogDiagnostics: vi.fn(async () => diagnostics),
    pickArxmlFile: vi.fn(async () => "C:\\bench\\custom.arxml"),
    onCatalogState: vi.fn((cb: (s: CatalogStateEvent) => void) => {
      stateCb = cb;
      return () => {
        stateCb = null;
      };
    }),
    __setRejectModel: (v: boolean) => {
      rejectModel = v;
    },
    __setImportReject: (msg: string | null) => {
      importReject = msg;
    },
    __setDiagnostics: (d: CatalogDiagnostic[]) => {
      diagnostics = d;
    },
    __resetModel: () => {
      model = { loaded: false, source: "", services: [] };
      diagnostics = [];
      importReject = null;
      rejectModel = false;
    },
  };
});

import {
  catalogDiagnostics,
  catalogImport,
  catalogLoad,
  catalogUnload,
  fetchCatalogModel,
  pickArxmlFile,
} from "./desktop";
import { CatalogStore } from "./catalogStore";

type DesktopMock = {
  __setRejectModel: (v: boolean) => void;
  __setImportReject: (msg: string | null) => void;
  __setDiagnostics: (d: CatalogDiagnostic[]) => void;
  __resetModel: () => void;
};

async function desktopMock(): Promise<DesktopMock> {
  return (await import("./desktop")) as unknown as DesktopMock;
}

describe("CatalogStore", () => {
  let store: CatalogStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    setCatalogNames(null);
    const desktop = await desktopMock();
    desktop.__resetModel();
    store = new CatalogStore();
  });

  afterEach(() => {
    setCatalogNames(null);
  });

  it("starts unloaded with the catalog tooltip (browser / empty model)", async () => {
    await Promise.resolve();
    expect(store.getSnapshot().loaded).toBe(false);
    expect(store.railTooltip()).toBe("Service catalog");
    expect(store.railActionLabel()).toBe("Service catalog");
    expect(getCatalogNames()).toBeNull();
    expect(resolveSomeIpName(0x1101, 0x8001)).toBe("CameraObjects.ObjectList");
  });

  it("toggleDecode wires catalog:state → model → frameModel names", async () => {
    await store.toggleDecode();
    await vi.waitFor(() => {
      expect(store.getSnapshot().loaded).toBe(true);
      expect(getCatalogNames()).not.toBeNull();
    });
    expect(catalogLoad).toHaveBeenCalled();
    expect(fetchCatalogModel).toHaveBeenCalled();
    expect(store.resolve(0x1101, 0x8001)).toEqual({
      serviceName: "CameraObjects",
      eventName: "ObjectList",
    });
    expect(store.resolve(0x1201, 0x8002)).toEqual({
      serviceName: "FusedObjects",
      eventName: "FusionStats",
    });
    expect(resolveSomeIpName(0x1201, 0x8002)).toBe("FusedObjects.FusionStats");
    expect(store.getSnapshot().sourceKind).toBe("embedded");
    expect(store.getSnapshot().signalCount).toBe(3);
    expect(store.railTooltip()).toContain("embedded demo catalog");
  });

  it("unload clears names and restores the static fallback", async () => {
    store.applyModelForTest({
      loaded: true,
      source: "catalog/sensor-fusion.arxml",
      services: [
        {
          serviceId: 0x1101,
          name: "CameraObjects",
          instanceId: 1,
          events: [{ eventId: 0x8001, name: "ObjectList", signals: [] }],
          methods: [],
        },
      ],
    });
    expect(resolveSomeIpName(0x1101, 0x8001)).toBe("CameraObjects.ObjectList");

    await store.unload();
    await vi.waitFor(() => expect(store.getSnapshot().loaded).toBe(false));
    expect(catalogUnload).toHaveBeenCalled();
    expect(getCatalogNames()).toBeNull();
  });

  it("importArxml picks a file, imports, and fetches diagnostics on warnings", async () => {
    await store.importArxml();
    await vi.waitFor(() => {
      expect(store.getSnapshot().loaded).toBe(true);
      expect(store.getSnapshot().warnings).toBe(1);
    });
    expect(pickArxmlFile).toHaveBeenCalled();
    expect(catalogImport).toHaveBeenCalledWith("C:\\bench\\custom.arxml");
    await vi.waitFor(() => {
      expect(catalogDiagnostics).toHaveBeenCalled();
      expect(store.getSnapshot().diagnostics).toHaveLength(1);
    });
    expect(store.getSnapshot().diagnostics[0]?.message).toBe("skipped FIELD");
    expect(store.getSnapshot().lastError).toBeNull();
  });

  it("keeps the previous catalog and sets lastError when import rejects", async () => {
    store.applyModelForTest({
      loaded: true,
      source: "catalog/sensor-fusion.arxml",
      services: [
        {
          serviceId: 0x1101,
          name: "CameraObjects",
          instanceId: 1,
          events: [{ eventId: 0x8001, name: "ObjectList", signals: [] }],
          methods: [],
        },
      ],
    });
    const desktop = await desktopMock();
    desktop.__setImportReject("XML syntax error at line 12");
    await store.importArxml();
    expect(store.getSnapshot().loaded).toBe(true);
    expect(store.getSnapshot().source).toBe("catalog/sensor-fusion.arxml");
    expect(store.getSnapshot().lastError).toBe("XML syntax error at line 12");
    expect(resolveSomeIpName(0x1101, 0x8001)).toBe("CameraObjects.ObjectList");
  });

  it("applyStateForTest updates sourceKind / counts / lastError", () => {
    store.applyStateForTest({
      loaded: true,
      serviceCount: 4,
      signalCount: 9,
      source: "/tmp/x.arxml",
      sourceKind: "file",
      errors: 1,
      warnings: 2,
      lastError: null,
    });
    const snap = store.getSnapshot();
    expect(snap.serviceCount).toBe(4);
    expect(snap.signalCount).toBe(9);
    expect(snap.sourceKind).toBe("file");
    expect(snap.errors).toBe(1);
    expect(snap.warnings).toBe(2);
  });

  it("reload is a no-op for embedded sources", async () => {
    store.applyStateForTest({
      loaded: true,
      serviceCount: 1,
      signalCount: 0,
      source: "catalog/sensor-fusion.arxml",
      sourceKind: "embedded",
      errors: 0,
      warnings: 0,
      lastError: null,
    });
    const { catalogReload } = await import("./desktop");
    await store.reload();
    expect(catalogReload).not.toHaveBeenCalled();
  });

  it("stays unloaded when catalog_model rejects (browser degradation)", async () => {
    const desktop = await desktopMock();
    desktop.__setRejectModel(true);
    const browserStore = new CatalogStore();
    await Promise.resolve();
    await Promise.resolve();
    expect(browserStore.getSnapshot().loaded).toBe(false);
    expect(getCatalogNames()).toBeNull();
    desktop.__setRejectModel(false);
  });

  it("notifies subscribers on load/unload", () => {
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().loaded));
    store.applyModelForTest({
      loaded: true,
      source: "x",
      services: [
        {
          serviceId: 1,
          name: "S",
          instanceId: 1,
          events: [{ eventId: 1, name: "E", signals: [] }],
          methods: [],
        },
      ],
    });
    store.applyModelForTest({ loaded: false, source: "", services: [] });
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
  });
});
