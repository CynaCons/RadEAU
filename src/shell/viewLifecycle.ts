import { useEffect, useSyncExternalStore } from "react";

/**
 * The suspend/resume contract every view implements from its first commit
 * (PRD §3.6, decision D4). Views stay mounted and hidden (keep-alive); a
 * suspended view must release buffers, unsubscribe, and drop graphics
 * contexts. In v0.1.x the skeletons register no-op handlers — the contract
 * and its call sites exist from day one so no view is retrofitted later.
 */
export interface ViewLifecycle {
  onSuspend?: () => void;
  onResume?: () => void;
}

const registry = new Map<string, ViewLifecycle>();
const active = new Set<string>();
const activeListeners = new Set<() => void>();

function notifyActive(): void {
  for (const cb of activeListeners) cb();
}

function subscribeActive(cb: () => void): () => void {
  activeListeners.add(cb);
  return () => activeListeners.delete(cb);
}

export function registerViewLifecycle(viewId: string, lifecycle: ViewLifecycle): () => void {
  registry.set(viewId, lifecycle);
  return () => {
    registry.delete(viewId);
  };
}

export function resumeView(viewId: string): void {
  if (active.has(viewId)) return;
  active.add(viewId);
  registry.get(viewId)?.onResume?.();
  notifyActive();
}

export function suspendView(viewId: string): void {
  if (!active.has(viewId)) return;
  active.delete(viewId);
  registry.get(viewId)?.onSuspend?.();
  notifyActive();
}

/** React hook: register this view's lifecycle handlers for its whole mount. */
export function useViewLifecycle(viewId: string, lifecycle: ViewLifecycle): void {
  useEffect(() => registerViewLifecycle(viewId, lifecycle), [viewId, lifecycle]);
}

/**
 * React hook: whether this view is resumed. Hidden keep-alive views use it to
 * do zero render work — subscriptions that only feed the screen are skipped
 * while it is false and the view catches up from the store on resume.
 */
export function useViewActive(viewId: string): boolean {
  // VU-027: hidden keep-alive views unsubscribe from display-only updates.
  return useSyncExternalStore(subscribeActive, () => active.has(viewId));
}
