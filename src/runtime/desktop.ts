/**
 * The one thin wrapper around every desktop-API call (PRD §3.6). In a plain
 * browser every function degrades to an inert no-op with a valid return value
 * (including valid unsubscribe handles), so the UI loads for component work
 * and E2E without a native build. No module outside this file may import
 * from @tauri-apps/api.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function minimizeWindow(): void {
  if (!isDesktop()) return;
  void getCurrentWindow().minimize();
}

export function toggleMaximizeWindow(): void {
  if (!isDesktop()) return;
  void getCurrentWindow().toggleMaximize();
}

export function closeWindow(): void {
  if (!isDesktop()) return;
  void getCurrentWindow().close();
}

/**
 * Subscribes to maximize-state changes; fires immediately with the current
 * state. Returns a valid unsubscribe in both environments.
 */
export function onMaximizedChange(cb: (maximized: boolean) => void): () => void {
  if (!isDesktop()) {
    cb(false);
    return () => {};
  }
  const win = getCurrentWindow();
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void win.isMaximized().then((m) => {
    if (!disposed) cb(m);
  });
  void win
    .onResized(() => {
      void win.isMaximized().then((m) => {
        if (!disposed) cb(m);
      });
    })
    .then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
