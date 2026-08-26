import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CellTowerIcon from "@mui/icons-material/CellTower";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import HubIcon from "@mui/icons-material/Hub";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { RaisedPanel } from "../components/RaisedPanel";
import { useViewLifecycle } from "../shell/viewLifecycle";

// ---------------------------------------------------------------------------
// Shared machine-data style (SRS_visual_ui.md §3): mono + tabular numerals.
const MONO = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
} as const;

/** Service id as 0x + 4-digit zero-padded uppercase hex (SRS §3). */
function fmtServiceId(id: number): string {
  return `0x${id.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Signed µs/ppm value at fixed 4 decimals; zero renders +0.0000, never 0. */
function fmtSigned4(v: number): string {
  return `${v < 0 ? "-" : "+"}${Math.abs(v).toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Mock data — replaced by live SD/PTP observation when the core lands.
// Deterministic; plausible SOME/IP sensor-fusion network (PRD §3.4).

type NodeState = "Online" | "Degraded" | "Offline";

const NODE_STATE_COLOR: Record<NodeState, "success" | "warning" | "error"> = {
  Online: "success",
  Degraded: "warning",
  Offline: "error",
};

const ECU_NODES: {
  name: string;
  addr: string;
  state: NodeState;
  offers: number[];
  subs: number;
  drops: number;
}[] = [
  { name: "CameraECU", addr: "10.42.0.11", state: "Online", offers: [0x1101], subs: 0, drops: 0 },
  { name: "RadarECU", addr: "10.42.0.12", state: "Online", offers: [0x1102], subs: 0, drops: 0 },
  { name: "LidarECU", addr: "10.42.0.13", state: "Degraded", offers: [0x1103], subs: 0, drops: 7 },
  { name: "DynamicsECU", addr: "10.42.0.14", state: "Online", offers: [0x1104], subs: 0, drops: 0 },
  { name: "GatewayECU", addr: "10.42.0.15", state: "Offline", offers: [], subs: 0, drops: 12 },
  { name: "FusionECU", addr: "10.42.0.20", state: "Online", offers: [0x1201], subs: 4, drops: 0 },
];

type SdState = "Offered" | "Subscribed" | "Down";

const SD_STATE_COLOR: Record<SdState, "info" | "success" | "error"> = {
  Offered: "info",
  Subscribed: "success",
  Down: "error",
};

const SD_SERVICES: { name: string; id: number; state: SdState; ttlS: number | null }[] = [
  { name: "CameraObjects", id: 0x1101, state: "Offered", ttlS: 2.4 },
  { name: "RadarTargets", id: 0x1102, state: "Subscribed", ttlS: 2.15 },
  { name: "LidarClusters", id: 0x1103, state: "Down", ttlS: null },
  { name: "VehicleDynamics", id: 0x1104, state: "Subscribed", ttlS: 1.9 },
  { name: "FusedObjects", id: 0x1201, state: "Offered", ttlS: 2.86 },
];

const PTP_GRANDMASTER = {
  name: "DynamicsECU",
  addr: "10.42.0.14",
  clockId: "00:1B:19:FF:FE:00:2A:01",
  domain: 0,
};

const PTP_NODES: { name: string; addr: string; offsetUs: number; pathDelayUs: number }[] = [
  { name: "CameraECU", addr: "10.42.0.11", offsetUs: 0.124, pathDelayUs: 1.842 },
  { name: "RadarECU", addr: "10.42.0.12", offsetUs: -0.0862, pathDelayUs: 2.031 },
  { name: "LidarECU", addr: "10.42.0.13", offsetUs: 0.3115, pathDelayUs: 1.767 },
  { name: "GatewayECU", addr: "10.42.0.15", offsetUs: -0.0417, pathDelayUs: 0.984 },
  { name: "FusionECU", addr: "10.42.0.20", offsetUs: 0.0958, pathDelayUs: 1.253 },
];

// ---------------------------------------------------------------------------

export function NetworkView() {
  useViewLifecycle("network", {});
  const [simLink, setSimLink] = useState(true);
  const [captureLink, setCaptureLink] = useState(true);
  const [connected, setConnected] = useState(true);

  return (
    <Stack spacing={2}>
      {/* ------------------------------------------------ Connection panel */}
      <RaisedPanel
        icon={<SettingsEthernetIcon sx={{ color: "var(--accent-primary)" }} />}
        title="Connection"
        subtitle="Simulator and capture links observed by this session."
        testId="network-connection-panel"
      >
        <Stack spacing={2}>
          <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap">
            <Stack direction="row" alignItems="center" spacing={1}>
              <Switch
                size="small"
                checked={simLink}
                onChange={(e) => setSimLink(e.target.checked)}
                inputProps={{ "aria-label": "Simulator link" }}
                data-testid="network-sim-link-switch"
              />
              <Typography sx={{ fontSize: 14 }}>Simulator link</Typography>
            </Stack>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Switch
                size="small"
                checked={captureLink}
                onChange={(e) => setCaptureLink(e.target.checked)}
                inputProps={{ "aria-label": "Capture link" }}
                data-testid="network-capture-link-switch"
              />
              <Typography sx={{ fontSize: 14 }}>Capture link</Typography>
            </Stack>
          </Stack>

          {/* Inline error/warning appears beneath the row that caused it (§5.8). */}
          {captureLink ? (
            <Alert severity="warning" variant="outlined" data-testid="network-capture-alert">
              Capture link is enabled but no interface is selected — showing simulator frames
              only.
            </Alert>
          ) : null}

          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Tooltip title={connected ? "Disconnect to edit the endpoint" : ""}>
              <TextField
                size="small"
                label="Host"
                defaultValue="10.42.0.1"
                disabled={connected}
                sx={{ width: 160 }}
                inputProps={{ "aria-label": "Simulator host", sx: { ...MONO, fontSize: 13 } }}
                data-testid="network-host-field"
              />
            </Tooltip>
            <Tooltip title={connected ? "Disconnect to edit the endpoint" : ""}>
              <TextField
                size="small"
                label="Port"
                defaultValue="30490"
                disabled={connected}
                sx={{ width: 96 }}
                inputProps={{ "aria-label": "Simulator port", sx: { ...MONO, fontSize: 13 } }}
                data-testid="network-port-field"
              />
            </Tooltip>
            <Tooltip title={connected ? "Already connected" : ""}>
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  color="success"
                  disabled={connected}
                  onClick={() => setConnected(true)}
                  data-testid="network-connect-btn"
                >
                  Connect
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={connected ? "" : "Not connected"}>
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  color="error"
                  disabled={!connected}
                  onClick={() => setConnected(false)}
                  data-testid="network-disconnect-btn"
                >
                  Disconnect
                </Button>
              </span>
            </Tooltip>
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              variant="outlined"
              icon={
                <FiberManualRecordIcon
                  sx={{
                    fontSize: 10,
                    color: connected ? "var(--success)" : "var(--error)",
                  }}
                />
              }
              label={connected ? "Link up" : "Link down"}
              data-testid="network-link-chip"
            />
            <Chip
              size="small"
              variant="outlined"
              label="UDP 30490"
              sx={{ ...MONO, fontSize: 12 }}
            />
            <Chip
              size="small"
              variant="outlined"
              label="RX 12480"
              sx={{ ...MONO, fontSize: 12 }}
            />
            <Chip size="small" variant="outlined" label="TX 3214" sx={{ ...MONO, fontSize: 12 }} />
            <Chip size="small" variant="outlined" label="SD 96" sx={{ ...MONO, fontSize: 12 }} />
            <Chip
              size="small"
              variant="outlined"
              label="Drops 3"
              sx={{ ...MONO, fontSize: 12 }}
            />
          </Stack>
        </Stack>
      </RaisedPanel>

      {/* -------------------------------------------------- Topology panel */}
      <RaisedPanel
        icon={<HubIcon sx={{ color: "var(--info)" }} />}
        title="Topology"
        subtitle="ECU nodes and subscription edges derived passively from observed SD traffic."
        testId="network-topology-panel"
      >
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
          {ECU_NODES.map((node) => (
            <Box
              key={node.addr}
              data-testid={`network-node-${node.addr}`}
              sx={{
                flex: "1 1 300px",
                minWidth: 0,
                p: 1.5,
                bgcolor: "var(--surface-raised-2)",
                border: "1px solid var(--border)",
                borderRadius: 1,
                display: "flex",
                alignItems: "center",
                gap: 1,
              }}
            >
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  sx={{
                    fontSize: 14,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {node.name}
                </Typography>
                <Typography sx={{ ...MONO, fontSize: 13, color: "text.secondary" }}>
                  {node.addr}
                </Typography>
                <Typography sx={{ ...MONO, fontSize: 12, color: "text.secondary" }}>
                  {node.offers.length > 0
                    ? `offers ${node.offers.map(fmtServiceId).join(" ")}`
                    : "offers --"}
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} alignItems="center">
                {/* Fixed 92 px so the card never reflows as the state string changes. */}
                <Chip
                  size="small"
                  color={NODE_STATE_COLOR[node.state]}
                  label={node.state}
                  sx={{ width: 92, fontWeight: 700 }}
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={`subs ${node.subs}`}
                  sx={{ ...MONO, fontSize: 12 }}
                />
                <Chip
                  size="small"
                  variant="outlined"
                  color={node.drops > 0 ? "warning" : undefined}
                  label={`drops ${node.drops}`}
                  sx={{ ...MONO, fontSize: 12 }}
                />
              </Stack>
            </Box>
          ))}
        </Box>
      </RaisedPanel>

      {/* ------------------------------------------------ SD monitor panel */}
      <RaisedPanel
        icon={<CellTowerIcon sx={{ color: "var(--accent-secondary)" }} />}
        title="SD monitor"
        subtitle="Per-service discovery state with TTL countdowns; transitions will link to Trace."
        testId="network-sd-panel"
      >
        <Box>
          {SD_SERVICES.map((svc, i) => (
            <Stack
              key={svc.id}
              direction="row"
              alignItems="center"
              spacing={2}
              data-testid={`network-sd-row-${fmtServiceId(svc.id)}`}
              sx={{
                height: 40,
                borderBottom:
                  i < SD_SERVICES.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <Typography
                sx={{
                  fontSize: 14,
                  width: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {svc.name}
              </Typography>
              <Typography sx={{ ...MONO, fontSize: 13, width: 70 }}>
                {fmtServiceId(svc.id)}
              </Typography>
              <Chip
                size="small"
                variant="outlined"
                color={SD_STATE_COLOR[svc.state]}
                label={svc.state}
              />
              <Box sx={{ flex: 1 }} />
              <Typography sx={{ ...MONO, fontSize: 12, color: "text.secondary" }}>
                {svc.ttlS === null ? "TTL --" : `TTL ${svc.ttlS.toFixed(4)} s`}
              </Typography>
            </Stack>
          ))}
        </Box>
      </RaisedPanel>

      {/* ------------------------------------------------------- PTP panel */}
      <RaisedPanel
        icon={<ScheduleIcon sx={{ color: "var(--series-16)" }} />}
        title="PTP"
        subtitle="gPTP sync tree; per-node offset and rate charts arrive with the graphing stack."
        testId="network-ptp-panel"
      >
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1.5} alignItems="baseline" flexWrap="wrap" useFlexGap>
            <Typography sx={{ fontSize: 14, fontWeight: 500 }}>Grandmaster</Typography>
            <Typography sx={{ fontSize: 14 }}>{PTP_GRANDMASTER.name}</Typography>
            <Typography sx={{ ...MONO, fontSize: 13 }}>{PTP_GRANDMASTER.addr}</Typography>
            <Typography sx={{ ...MONO, fontSize: 13, color: "text.secondary" }}>
              {PTP_GRANDMASTER.clockId}
            </Typography>
            <Typography sx={{ ...MONO, fontSize: 12, color: "text.secondary" }}>
              domain {PTP_GRANDMASTER.domain}
            </Typography>
          </Stack>

          <Box>
            <Stack direction="row" spacing={2} sx={{ height: 24, alignItems: "center" }}>
              <Typography sx={{ fontSize: 12, color: "text.secondary", width: 140 }}>
                Node
              </Typography>
              <Typography sx={{ fontSize: 12, color: "text.secondary", width: 110 }}>
                Address
              </Typography>
              <Typography
                sx={{ fontSize: 12, color: "text.secondary", width: 120, textAlign: "right" }}
              >
                Offset (µs)
              </Typography>
              <Typography
                sx={{ fontSize: 12, color: "text.secondary", width: 120, textAlign: "right" }}
              >
                Path delay (µs)
              </Typography>
            </Stack>
            {PTP_NODES.map((node, i) => (
              <Stack
                key={node.addr}
                direction="row"
                spacing={2}
                alignItems="center"
                data-testid={`network-ptp-row-${node.addr}`}
                sx={{
                  height: 28,
                  borderBottom:
                    i < PTP_NODES.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <Typography sx={{ fontSize: 14, width: 140 }}>{node.name}</Typography>
                <Typography sx={{ ...MONO, fontSize: 13, width: 110 }}>{node.addr}</Typography>
                <Typography sx={{ ...MONO, fontSize: 13, width: 120, textAlign: "right" }}>
                  {fmtSigned4(node.offsetUs)}
                </Typography>
                <Typography sx={{ ...MONO, fontSize: 13, width: 120, textAlign: "right" }}>
                  {fmtSigned4(node.pathDelayUs)}
                </Typography>
              </Stack>
            ))}
          </Box>

          {/* Chart placeholder — the standard chart stack lands per SRS_graphing.md. */}
          <Box
            sx={{
              position: "relative",
              height: 96,
              border: "1px solid var(--border)",
              borderRadius: 1,
            }}
          >
            <EmptyState
              text="No offset history yet — charts arrive with the graphing stack"
              testId="network-ptp-chart-placeholder"
            />
          </Box>
        </Stack>
      </RaisedPanel>
    </Stack>
  );
}
