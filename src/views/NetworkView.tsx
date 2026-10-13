/**
 * Network view (SRS_visual_ui.md §5.8, §1.5): Connection panel from the
 * shared session store; Topology / SD / PTP show honest empty states until
 * live decode arrives. No fabricated ECUs, counters, or topology.
 */

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import CellTowerIcon from "@mui/icons-material/CellTower";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import HubIcon from "@mui/icons-material/Hub";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import QueryStatsIcon from "@mui/icons-material/QueryStats";
import { useMemo } from "react";
import { EmptyState } from "../components/EmptyState";
import { RaisedPanel } from "../components/RaisedPanel";
import { analysisStore } from "../runtime/analysisStore";
import {
  droppedBreakdownTooltip,
  linkChipColorVar,
} from "../runtime/captureSource";
import {
  buildNetworkAnalysisTables,
  connectionPanelModel,
  NETWORK_EMPTY,
  type NetworkAnalysisTables,
} from "../runtime/networkDisplay";
import { sessionStore } from "../runtime/sessionStore";
import {
  automationClientsStore,
  automationStatusText,
} from "../runtime/automationClientsStore";
import { shallowEqual, useStoreSelector } from "../runtime/useStoreSelector";
import { useViewActive, useViewLifecycle } from "../shell/viewLifecycle";

const MONO = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
} as const;

type Align = "left" | "right";

interface TextColumn<T> {
  readonly key: keyof T;
  readonly label: string;
  readonly align?: Align;
  readonly mono?: boolean;
}

function SnapshotTable<T extends object>(props: {
  readonly testId: string;
  readonly columns: readonly TextColumn<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T, index: number) => string;
  readonly rowTestId?: (row: T, index: number) => string | undefined;
}) {
  const { testId, columns, rows, rowKey, rowTestId } = props;
  return (
    <TableContainer
      data-testid={testId}
      sx={{
        border: "1px solid var(--border)",
        borderRadius: 1,
        overflowX: "auto",
      }}
    >
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            {columns.map((col) => (
              <TableCell
                key={String(col.key)}
                align={col.align}
                sx={{
                  bgcolor: "var(--surface-raised-2)",
                  color: "text.secondary",
                  fontSize: 12,
                  fontWeight: 500,
                  py: 0.75,
                  ...(col.mono ? MONO : null),
                }}
              >
                {col.label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={rowKey(row, index)} data-testid={rowTestId?.(row, index)}>
              {columns.map((col) => (
                <TableCell
                  key={String(col.key)}
                  align={col.align}
                  sx={{
                    fontSize: 13,
                    py: 0.75,
                    borderColor: "var(--border)",
                    ...(col.mono ? MONO : null),
                  }}
                >
                  {String(row[col.key])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function EmptyAnalysisTable(props: { text: string; testId: string }) {
  return (
    <Box sx={{ position: "relative", height: 48 }}>
      <EmptyState text={props.text} inset testId={props.testId} />
    </Box>
  );
}

const endpointColumns: readonly TextColumn<NetworkAnalysisTables["endpoints"][number]>[] = [
  { key: "endpoint", label: "Endpoint", mono: true },
  { key: "kind", label: "Kind" },
  { key: "framesSent", label: "Frames sent", align: "right", mono: true },
  { key: "bytesSent", label: "Bytes sent", align: "right", mono: true },
  { key: "protocols", label: "Protocols" },
];

const conversationColumns: readonly TextColumn<NetworkAnalysisTables["conversations"][number]>[] = [
  { key: "peers", label: "Conversation", mono: true },
  { key: "transport", label: "Transport" },
  { key: "frames", label: "Frames", align: "right", mono: true },
  { key: "bytes", label: "Bytes", align: "right", mono: true },
  { key: "span", label: "First - last", align: "right", mono: true },
];

const someIpColumns: readonly TextColumn<NetworkAnalysisTables["someip"][number]>[] = [
  { key: "serviceMethod", label: "Service / method", mono: true },
  { key: "name", label: "Name" },
  { key: "sender", label: "Sender", mono: true },
  { key: "kind", label: "Kind" },
  { key: "count", label: "Count", align: "right", mono: true },
  { key: "periodMean", label: "Period mean", align: "right", mono: true },
  { key: "periodP99", label: "Period p99", align: "right", mono: true },
  { key: "latencyP99", label: "Latency p99", align: "right", mono: true },
  { key: "gaps", label: "Gaps", align: "right", mono: true },
];

const sdColumns: readonly TextColumn<NetworkAnalysisTables["sd"][number]>[] = [
  { key: "serviceInstance", label: "Service / instance", mono: true },
  { key: "sender", label: "Sender", mono: true },
  { key: "offers", label: "Offers", align: "right", mono: true },
  { key: "stopOffers", label: "Stop offers", align: "right", mono: true },
  { key: "periodMean", label: "Period mean", align: "right", mono: true },
  { key: "ttl", label: "TTL", align: "right", mono: true },
  { key: "reboots", label: "Reboots", align: "right", mono: true },
];

const ptpColumns: readonly TextColumn<NetworkAnalysisTables["ptp"][number]>[] = [
  { key: "sender", label: "Sender", mono: true },
  { key: "sync", label: "Sync", align: "right", mono: true },
  { key: "followUp", label: "Follow_Up", align: "right", mono: true },
  { key: "pdelay", label: "Pdelay req / resp", align: "right", mono: true },
  { key: "announce", label: "Announce", align: "right", mono: true },
  { key: "syncMean", label: "Sync mean", align: "right", mono: true },
  { key: "grandmaster", label: "Grandmaster", mono: true },
];

function NetworkStatsChips(props: { active: boolean }) {
  const rawStats = useStoreSelector(sessionStore, (snapshot) => snapshot.stats, Object.is, props.active);
  if (!rawStats) return null;
  const snapshot = sessionStore.getSnapshot();
  const stats = connectionPanelModel({ ...snapshot, stats: rawStats }).stats;
  if (!stats) return null;
  const droppedWarning = stats.dropped > 0;
  const droppedTooltip = droppedBreakdownTooltip(rawStats);
  return (
    <>
      <Chip size="small" variant="outlined" label={`Received ${stats.received.toLocaleString("en-US")}`} data-testid="network-stat-received" />
      <Chip size="small" variant="outlined" label={`Emitted ${stats.emitted.toLocaleString("en-US")}`} data-testid="network-stat-emitted" />
      <Tooltip title={droppedTooltip}>
        <Chip size="small" variant="outlined" label={`Dropped ${stats.dropped.toLocaleString("en-US")}`} data-testid="network-stat-dropped"
          sx={droppedWarning ? { color: "var(--warning)", borderColor: "var(--warning)" } : undefined} />
      </Tooltip>
      <Chip size="small" variant="outlined" label={`Gaps ${stats.gaps.toLocaleString("en-US")}`} data-testid="network-stat-gaps" />
      <Chip size="small" variant="outlined" label={`Malformed ${stats.malformed.toLocaleString("en-US")}`} data-testid="network-stat-malformed" />
    </>
  );
}

function NetworkStatsDetails(props: { active: boolean }) {
  const rawStats = useStoreSelector(sessionStore, (snapshot) => snapshot.stats, Object.is, props.active);
  if (!rawStats) return null;
  const stats = connectionPanelModel({ ...sessionStore.getSnapshot(), stats: rawStats }).stats;
  if (!stats) return null;
  return (
    <>
      {stats.classLine ? (
        <Typography sx={{ ...MONO, fontSize: 12, color: "text.secondary" }} data-testid="network-stat-classes">{stats.classLine}</Typography>
      ) : null}
      {stats.caption ? (
        <Typography sx={{ fontSize: 12, color: "text.secondary" }} data-testid="network-stats-caption">{stats.caption}</Typography>
      ) : null}
    </>
  );
}

/** AU-009: the automation endpoint's live status (agents connected via radeau-mcp). */
function AutomationStatus({ active }: { active: boolean }) {
  const text = useStoreSelector(automationClientsStore, automationStatusText, Object.is, active);
  return (
    <Typography sx={AUTOMATION_STATUS_SX} data-testid="network-automation-status">
      {text}
    </Typography>
  );
}

const AUTOMATION_STATUS_SX = { fontSize: 13, color: "text.secondary", px: 1.5 } as const;

export function NetworkView() {
  useViewLifecycle("network", {});
  const active = useViewActive("network");
  const analysis = useStoreSelector(
    analysisStore,
    ({ running, result, error }) => ({ running, result, error }),
    shallowEqual,
    active,
  );
  const session = useStoreSelector(
    sessionStore,
    ({ running, sourceKind, simAddr, pcapPath, pcapStreamAddr, liveInterfaceId, linkStatus, sessionInfo }) =>
      ({ running, sourceKind, simAddr, pcapPath, pcapStreamAddr, liveInterfaceId, linkStatus, sessionInfo }),
    shallowEqual,
    active,
  );
  const model = useMemo(
    () =>
      connectionPanelModel({
        running: session.running,
        sourceKind: session.sourceKind,
        simAddr: session.simAddr,
        pcapPath: session.pcapPath,
        pcapStreamAddr: session.pcapStreamAddr,
        liveInterfaceId: session.liveInterfaceId,
        linkStatus: session.linkStatus,
        sessionInfo: session.sessionInfo,
        stats: null,
      }),
    [session],
  );
  const tables = useMemo(
    () => (analysis.result ? buildNetworkAnalysisTables(analysis.result) : null),
    [analysis.result],
  );

  const linkColor = model.linkState
    ? linkChipColorVar(model.linkState)
    : "var(--text-secondary)";
  return (
    <Stack spacing={2}>
      <RaisedPanel
        icon={<SettingsEthernetIcon sx={{ color: "var(--accent-primary)" }} />}
        title="Connection"
        subtitle="Everything the core is connected to in this session."
        testId="network-connection-panel"
      >
        <Stack spacing={2}>
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 500 }} data-testid="network-source-kind">
              {model.sourceLabel}
            </Typography>
            {model.address ? (
              <Typography
                sx={{ ...MONO, fontSize: 13, color: "text.secondary" }}
                data-testid="network-source-addr"
              >
                {model.address}
              </Typography>
            ) : null}
            {model.scenario ? (
              <Typography
                sx={{ fontSize: 13, color: "text.secondary" }}
                data-testid="network-source-scenario"
              >
                Scenario: {model.scenario}
              </Typography>
            ) : null}
            {model.timestampSource ? (
              <Typography
                sx={{ fontSize: 13, color: "text.secondary" }}
                data-testid="network-timestamp-source"
              >
                Timestamp source: {model.timestampSource}
              </Typography>
            ) : null}
          </Box>

          {model.stoppedHint ? (
            <Typography
              sx={{ fontSize: 14, color: "text.secondary" }}
              data-testid="network-stopped-hint"
            >
              {model.stoppedHint}
            </Typography>
          ) : null}

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              variant="outlined"
              icon={
                <FiberManualRecordIcon
                  sx={{
                    fontSize: 10,
                    color: model.running ? "var(--success)" : "var(--text-secondary)",
                  }}
                />
              }
              label={model.sessionChipLabel}
              data-testid="network-session-chip"
            />
            {model.linkChipLabel ? (
              <Chip
                size="small"
                variant="outlined"
                icon={
                  <FiberManualRecordIcon sx={{ fontSize: 10, color: linkColor }} />
                }
                label={model.linkChipLabel}
                data-testid="network-link-chip"
                sx={{
                  color: linkColor,
                  borderColor: linkColor,
                }}
              />
            ) : null}
            {model.linkDetail ? (
              <Typography
                sx={{ ...MONO, fontSize: 12, color: "text.secondary", alignSelf: "center" }}
                data-testid="network-link-detail"
              >
                {model.linkDetail}
              </Typography>
            ) : null}
            <NetworkStatsChips active={active} />
          </Stack>

          <NetworkStatsDetails active={active} />

          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button
              variant="outlined"
              size="small"
              startIcon={
                analysis.running ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <QueryStatsIcon />
                )
              }
              disabled={analysis.running}
              onClick={() => {
                void analysisStore.run({ kind: "ring" });
              }}
              data-testid="network-analyze-btn"
            >
              Analyze buffered trace
            </Button>
            {tables ? (
              <Typography
                sx={{ fontSize: 12, color: "text.secondary" }}
                data-testid="network-analysis-caption"
              >
                {tables.caption}
              </Typography>
            ) : null}
          </Stack>
          {analysis.error ? (
            <Alert severity="error" data-testid="network-analysis-error">
              {analysis.error}
            </Alert>
          ) : null}

          <Box sx={{ position: "relative", height: 36 }}>
            <EmptyState
              text={NETWORK_EMPTY.externalNodes}
              inset
              testId="network-external-nodes-empty"
            />
          </Box>
          <AutomationStatus active={active} />
        </Stack>
      </RaisedPanel>

      {/* NV-004 */}
      <RaisedPanel
        icon={<HubIcon sx={{ color: "var(--info)" }} />}
        title="Topology"
        subtitle="ECU nodes and subscription edges derived passively from observed SD traffic."
        testId="network-topology-panel"
      >
        {tables ? (
          <Stack spacing={1.5}>
            {tables.endpoints.length > 0 ? (
              <SnapshotTable
                testId="network-endpoints-table"
                columns={endpointColumns}
                rows={tables.endpoints}
                rowKey={(row) => row.endpoint}
              />
            ) : (
              <EmptyAnalysisTable
                text="snapshot has no endpoints"
                testId="network-endpoints-empty"
              />
            )}
            {tables.conversations.length > 0 ? (
              <SnapshotTable
                testId="network-conversations-table"
                columns={conversationColumns}
                rows={tables.conversations}
                rowKey={(row, index) => `${row.peers}-${index}`}
              />
            ) : (
              <EmptyAnalysisTable
                text="snapshot has no conversations"
                testId="network-conversations-empty"
              />
            )}
          </Stack>
        ) : (
          <EmptyAnalysisTable text={NETWORK_EMPTY.analysis} testId="network-topology-empty" />
        )}
      </RaisedPanel>

      <RaisedPanel
        icon={<QueryStatsIcon sx={{ color: "var(--success)" }} />}
        title="SOME/IP services"
        subtitle="Per service/method/sender counts, periods, latency, and retained gaps from the last analysis snapshot."
        testId="network-someip-panel"
      >
        {tables ? (
          tables.someip.length > 0 ? (
            <SnapshotTable
              testId="network-someip-table"
              columns={someIpColumns}
              rows={tables.someip}
              rowKey={(row, index) => `${row.testId}-${row.sender}-${index}`}
              rowTestId={(row) => row.testId}
            />
          ) : (
            <EmptyAnalysisTable
              text="snapshot has no SOME/IP services"
              testId="network-someip-empty"
            />
          )
        ) : (
          <EmptyAnalysisTable text={NETWORK_EMPTY.analysis} testId="network-someip-empty" />
        )}
      </RaisedPanel>

      {/* NV-004 */}
      <RaisedPanel
        icon={<CellTowerIcon sx={{ color: "var(--accent-secondary)" }} />}
        title="SD monitor"
        subtitle="Per-service discovery state with TTL countdowns; transitions will link to Trace."
        testId="network-sd-panel"
      >
        {tables ? (
          tables.sd.length > 0 ? (
            <SnapshotTable
              testId="network-sd-table"
              columns={sdColumns}
              rows={tables.sd}
              rowKey={(row, index) => `${row.serviceInstance}-${row.sender}-${index}`}
            />
          ) : (
            <EmptyAnalysisTable text="snapshot has no SD instances" testId="network-sd-empty" />
          )
        ) : (
          <EmptyAnalysisTable text={NETWORK_EMPTY.analysis} testId="network-sd-empty" />
        )}
      </RaisedPanel>

      {/* NV-004 */}
      <RaisedPanel
        icon={<ScheduleIcon sx={{ color: "var(--series-16)" }} />}
        title="PTP"
        subtitle="gPTP sync tree; per-node offset and rate charts arrive with the graphing stack."
        testId="network-ptp-panel"
      >
        {tables ? (
          tables.ptp.length > 0 ? (
            <SnapshotTable
              testId="network-ptp-table"
              columns={ptpColumns}
              rows={tables.ptp}
              rowKey={(row) => row.sender}
            />
          ) : (
            <EmptyAnalysisTable text="snapshot has no PTP senders" testId="network-ptp-empty" />
          )
        ) : (
          <EmptyAnalysisTable text={NETWORK_EMPTY.analysis} testId="network-ptp-empty" />
        )}
      </RaisedPanel>
    </Stack>
  );
}
