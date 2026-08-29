/**
 * Cached `app_info` — fetched once at startup for About, Settings (devgen
 * visibility), and the session default source.
 */

import { appInfo, type AppInfo } from "./desktop";

const FALLBACK: AppInfo = {
  version: "browser",
  buildProfile: "browser",
  os: "browser",
  devgenAvailable: true,
};

export interface AppInfoSnapshot {
  readonly ready: boolean;
  readonly info: AppInfo;
}

export class AppInfoStore {
  private ready = false;
  private info: AppInfo = FALLBACK;
  private listeners = new Set<() => void>();
  private snapshot: AppInfoSnapshot;
  private loadPromise: Promise<AppInfo> | null = null;

  constructor() {
    this.snapshot = this.buildSnapshot();
    void this.ensureLoaded();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): AppInfoSnapshot => this.snapshot;

  /** Resolves once the first fetch completes (cached thereafter). */
  ensureLoaded(): Promise<AppInfo> {
    if (this.ready) return Promise.resolve(this.info);
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = appInfo()
      .then((info) => {
        this.info = info;
        this.ready = true;
        this.publish();
        return info;
      })
      .catch(() => {
        // Keep the browser-shaped fallback so UI still renders.
        this.ready = true;
        this.publish();
        return this.info;
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  private buildSnapshot(): AppInfoSnapshot {
    return { ready: this.ready, info: this.info };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }
}

/** Application-wide app-info singleton. */
export const appInfoStore = new AppInfoStore();
