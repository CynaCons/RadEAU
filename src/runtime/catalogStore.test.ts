import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCatalogNames, resolveSomeIpName, setCatalogNames } from "./frameModel";

vi.mock("./desktop", () => {
  let stateCb: ((s: { loaded: boolean; serviceCount: number }) => void) | null = null;
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
      stateCb?.({ loaded: true, serviceCount: model.services.length });
    }),
    catalogUnload: vi.fn(async () => {
      model = { loaded: false, source: "", services: [] };
      stateCb?.({ loaded: false, serviceCount: 0 });
    }),
    onCatalogState: vi.fn((cb: (s: { loaded: boolean; serviceCount: number }) => void) => {
      stateCb = cb;
      return () => {
        stateCb = null;
      };
    }),
    __setRejectModel: (v: boolean) => {
      rejectModel = v;
    },
    __getStateCb: () => stateCb,
    __setModel: (m: typeof model) => {
      model = m;
    },
  };
});

import {
  catalogLoad,
  catalogUnload,
  fetchCatalogModel,
} from "./desktop";
import { CatalogStore } from "./catalogStore";

describe("CatalogStore", () => {
  let store: CatalogStore;

  beforeEach(() => {
    vi.clearAllMocks();
    setCatalogNames(null);
    store = new CatalogStore();
  });

  afterEach(() => {
    setCatalogNames(null);
  });

  it("starts unloaded with the load tooltip (browser / empty model)", async () => {
    await Promise.resolve();
    expect(store.getSnapshot().loaded).toBe(false);
    expect(store.railTooltip()).toBe("Load service catalog");
    expect(store.railActionLabel()).toBe("Load service catalog");
    expect(getCatalogNames()).toBeNull();
    expect(resolveSomeIpName(0x1101, 0x8001)).toBe("CameraObjects.ObjectList");
  });

  it("load wires catalog:state → model → frameModel names + tooltip", async () => {
    await store.load();
    // catalogLoad emits state; store refreshModel is async.
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
    expect(store.resolve(0x1201, 1)).toEqual({
      serviceName: "FusedObjects",
      eventName: "SetFusionMode",
    });
    expect(resolveSomeIpName(0x1201, 0x8002)).toBe("FusedObjects.FusionStats");
    expect(store.railTooltip()).toBe("catalog/sensor-fusion.arxml · 2 services");
    expect(store.railActionLabel()).toBe("Unload service catalog");
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
    expect(store.railTooltip()).toBe("Load service catalog");
  });

  it("toggle mirrors the rail button contract", async () => {
    await store.toggle();
    await vi.waitFor(() => expect(store.getSnapshot().loaded).toBe(true));
    await store.toggle();
    await vi.waitFor(() => expect(store.getSnapshot().loaded).toBe(false));
  });

  it("stays unloaded when catalog_model rejects (browser degradation)", async () => {
    const desktop = (await import("./desktop")) as unknown as {
      __setRejectModel: (v: boolean) => void;
    };
    desktop.__setRejectModel(true);
    const browserStore = new CatalogStore();
    await Promise.resolve();
    await Promise.resolve();
    expect(browserStore.getSnapshot().loaded).toBe(false);
    expect(getCatalogNames()).toBeNull();
    desktop.__setRejectModel(false);
  });

  it("notifies subscribers on load/unload", async () => {
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
