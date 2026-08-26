import type { ComponentType } from "react";
import TerminalIcon from "@mui/icons-material/Terminal";
import WavesIcon from "@mui/icons-material/Waves";
import HubIcon from "@mui/icons-material/Hub";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import SendIcon from "@mui/icons-material/Send";
import CodeIcon from "@mui/icons-material/Code";
import SettingsIcon from "@mui/icons-material/Settings";
import type { SvgIconComponent } from "@mui/icons-material";
import { TraceView } from "../views/TraceView";
import { SignalsView } from "../views/SignalsView";
import { NetworkView } from "../views/NetworkView";
import { RecorderView } from "../views/RecorderView";
import { SimulationView } from "../views/SimulationView";
import { AutomationView } from "../views/AutomationView";
import { SettingsView } from "../views/SettingsView";

/**
 * Rail order and icons per SRS_visual_ui.md §4.4. `fullBleed` views own their
 * edges (zero content padding). Protocols ships later and stays hidden until
 * it exists; when the active view is hidden by an operating mode, navigation
 * falls back to Trace.
 */
export interface ViewEntry {
  id: string;
  label: string;
  icon: SvgIconComponent;
  component: ComponentType;
  fullBleed?: boolean;
}

export const VIEWS: ViewEntry[] = [
  { id: "trace", label: "Trace", icon: TerminalIcon, component: TraceView, fullBleed: true },
  { id: "signals", label: "Signals", icon: WavesIcon, component: SignalsView, fullBleed: true },
  { id: "network", label: "Network", icon: HubIcon, component: NetworkView },
  { id: "recorder", label: "Recorder", icon: RadioButtonCheckedIcon, component: RecorderView },
  { id: "simulation", label: "Simulation", icon: SendIcon, component: SimulationView, fullBleed: true },
  { id: "automation", label: "Automation", icon: CodeIcon, component: AutomationView, fullBleed: true },
  { id: "settings", label: "Settings", icon: SettingsIcon, component: SettingsView },
];

export const DEFAULT_VIEW_ID = "trace";
