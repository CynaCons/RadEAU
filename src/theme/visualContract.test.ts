import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static contract checks for shell-level visual requirements that live in
// configuration and entry files rather than in a rendered component.
const root = join(__dirname, "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

interface TauriWindow {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  decorations: boolean;
}

function mainWindow(): TauriWindow {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    app: { windows: TauriWindow[] };
  };
  const window = conf.app.windows[0];
  if (!window) throw new Error("tauri.conf.json declares no window");
  return window;
}

describe("shell visual contract", () => {
  it("bundles both font stacks with the application (VU-006)", () => {
    const entry = read("src/main.tsx");
    expect(entry).toMatch(/@fontsource\/roboto\/\d+\.css/);
    expect(entry).toMatch(/@fontsource\/roboto-mono\/\d+\.css/);
    const tokens = JSON.parse(read("src/theme/tokens.json")) as { font: Record<string, string> };
    expect(Object.values(tokens.font).join(" ")).toMatch(/Roboto Mono/);
  });

  it("runs undecorated with an app-drawn drag region whose controls opt out (VU-008)", () => {
    expect(mainWindow().decorations).toBe(false);
    const appBar = read("src/shell/AppTopBar.tsx");
    expect(appBar).toContain("data-tauri-drag-region");
    expect(appBar).toMatch(/onPointerDown: \(e: ReactPointerEvent\) => e\.stopPropagation\(\)/);
  });

  it("defaults the window to 1440 x 900 with a 1024 x 700 minimum (VU-009)", () => {
    const window = mainWindow();
    expect([window.width, window.height]).toEqual([1440, 900]);
    expect([window.minWidth, window.minHeight]).toEqual([1024, 700]);
  });

  it("paints the startup overlay before the app bundle and fades it after mount (VU-025)", () => {
    const html = read("index.html");
    const overlayAt = html.indexOf('<div id="startup-overlay"');
    const scriptAt = html.indexOf('<script type="module"');
    expect(overlayAt).toBeGreaterThan(0);
    expect(overlayAt).toBeLessThan(scriptAt);
    expect(html).toMatch(/#startup-overlay\s*\{[^}]*transition: opacity 220ms/);
    expect(html).toMatch(/#startup-overlay\.fading\s*\{[^}]*opacity: 0;/);
    const entry = read("src/main.tsx");
    expect(entry).toContain('classList.add("fading")');
    expect(entry).toMatch(/overlay\.remove\(\), 240\)/);
  });
});
