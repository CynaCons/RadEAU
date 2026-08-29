/**
 * Settings › Dependencies row model (SRS_visual_ui.md §5.7 / CP-008).
 * Pure helpers — views render from this shape; probes live in desktop.ts.
 */

export type DependencyId = "npcap" | "libpcap" | "vxlapi" | "vector-driver";

export type DependencyStatus =
  | "installed"
  | "missing"
  | "incompatible"
  | "blocked"
  | "not-applicable";

export interface DependencyRow {
  id: DependencyId;
  name: string;
  enables: string;
  status: DependencyStatus;
  version: string | null;
  path: string | null;
  detail: string | null;
  downloadUrl: string;
}

export interface DependencyChipModel {
  label: string;
  /** Token CSS variable for chip face. */
  colorVar: string;
  showDownload: boolean;
}

const DOWNLOAD_URLS: Record<DependencyId, string> = {
  npcap: "https://npcap.com/#download",
  libpcap: "https://www.tcpdump.org/",
  vxlapi: "https://www.vector.com/int/en/download/xl-driver-library/",
  "vector-driver": "https://vector.com/latest_driver",
};

const BROWSER_META: ReadonlyArray<{
  id: DependencyId;
  name: string;
  enables: string;
}> = [
  { id: "npcap", name: "Npcap", enables: "Windows live capture" },
  { id: "libpcap", name: "libpcap", enables: "Linux live capture" },
  {
    id: "vxlapi",
    name: "Vector XL Driver Library",
    enables: "Vector VN interfaces",
  },
  {
    id: "vector-driver",
    name: "Vector driver package",
    enables: "Vector VN interfaces",
  },
];

/** Four not-applicable rows for browser-mode Settings (desktop app only). */
export function browserDependencyRows(): DependencyRow[] {
  return BROWSER_META.map((m) => ({
    id: m.id,
    name: m.name,
    enables: m.enables,
    status: "not-applicable" as const,
    version: null,
    path: null,
    detail: "desktop app only",
    downloadUrl: DOWNLOAD_URLS[m.id],
  }));
}

/** Status chip label, token color, and whether to show Open download page. */
export function dependencyChipModel(row: DependencyRow): DependencyChipModel {
  switch (row.status) {
    case "installed":
      return {
        label: row.version ? `Installed · ${row.version}` : "Installed",
        colorVar: "var(--success)",
        showDownload: false,
      };
    case "missing":
      return {
        label: "Missing",
        colorVar: "var(--error)",
        showDownload: true,
      };
    case "incompatible":
      return {
        label: row.version ? `Incompatible · ${row.version}` : "Incompatible",
        colorVar: "var(--warning)",
        showDownload: true,
      };
    case "blocked":
      return {
        label: "Blocked",
        colorVar: "var(--warning)",
        showDownload: true,
      };
    case "not-applicable":
      return {
        label: "N/A",
        colorVar: "var(--text-secondary)",
        showDownload: false,
      };
  }
}

/** Mono path/version line under the chip; null when neither is present. */
export function dependencyPathLine(row: DependencyRow): string | null {
  if (row.path && row.version) return `${row.path} · ${row.version}`;
  if (row.path) return row.path;
  if (row.version) return row.version;
  return null;
}

/**
 * Platform live-capture dependency row (Npcap on Windows, libpcap on Linux).
 * Prefers the row that is not `not-applicable`; falls back to npcap then libpcap.
 */
export function liveCaptureDependency(
  rows: readonly DependencyRow[] | null | undefined,
): DependencyRow | null {
  if (!rows || rows.length === 0) return null;
  const npcap = rows.find((r) => r.id === "npcap") ?? null;
  const libpcap = rows.find((r) => r.id === "libpcap") ?? null;
  if (npcap && npcap.status !== "not-applicable") return npcap;
  if (libpcap && libpcap.status !== "not-applicable") return libpcap;
  return npcap ?? libpcap;
}

/** Host OS for the live-option disabled reason (§5.7). */
export function liveCapturePlatform(
  rows: readonly DependencyRow[] | null | undefined,
): "windows" | "linux" | "other" {
  const dep = liveCaptureDependency(rows);
  if (dep?.id === "libpcap") return "linux";
  if (dep?.id === "npcap") return "windows";
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("linux")) return "linux";
    if (ua.includes("win")) return "windows";
  }
  return "other";
}
