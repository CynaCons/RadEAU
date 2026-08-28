/**
 * Wireshark-style frame dissection panel for an expanded Trace row
 * (SRS_visual_ui.md §5.2). Fetches on mount; collapse unmounts and discards.
 */

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Box, CircularProgress, IconButton, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  fetchFrameDetail,
  type DecodedSignal,
  type FrameDetail,
  type FrameLayer,
} from "../runtime/desktop";
import {
  formatFieldExtent,
  formatHexDump,
  formatScaled,
  frameDetailErrorMessage,
  isMalformedLayerSummary,
  type HexDumpRow,
} from "../runtime/frameDetail";

const MONO: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
};

export type TraceDetailViewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: FrameDetail };

/** Presentational body — fixture-testable without invoking the desktop bridge. */
export function TraceDetailBody(props: {
  idx: number;
  state: TraceDetailViewState;
  showCapturedIdx?: boolean;
  collapsedLayers?: ReadonlySet<number>;
  onToggleLayer?: (layerIndex: number) => void;
}): ReactNode {
  const { idx, state, showCapturedIdx, collapsedLayers, onToggleLayer } = props;

  return (
    <Box
      data-testid={`trace-detail-${idx}`}
      sx={{
        backgroundColor: "var(--fill-subtle)",
        pl: "48px",
        pr: "12px",
        py: "8px",
        textAlign: "left",
        whiteSpace: "normal",
      }}
    >
      {state.status === "loading" ? (
        <Box
          data-testid="trace-detail-loading"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            height: 28,
            color: "text.secondary",
          }}
        >
          <CircularProgress size={14} thickness={5} sx={{ color: "var(--text-secondary)" }} />
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>Loading…</Typography>
        </Box>
      ) : null}

      {state.status === "error" ? (
        <Box
          data-testid="trace-detail-empty"
          sx={{
            height: 28,
            display: "flex",
            alignItems: "center",
            fontSize: 13,
            color: "text.secondary",
            opacity: 0.7,
          }}
        >
          {state.message}
        </Box>
      ) : null}

      {state.status === "ready" ? (
        <ReadyDetail
          detail={state.detail}
          showCapturedIdx={showCapturedIdx}
          collapsedLayers={collapsedLayers}
          onToggleLayer={onToggleLayer}
        />
      ) : null}
    </Box>
  );
}

function ReadyDetail(props: {
  detail: FrameDetail;
  showCapturedIdx?: boolean;
  collapsedLayers?: ReadonlySet<number>;
  onToggleLayer?: (layerIndex: number) => void;
}): ReactNode {
  const { detail, showCapturedIdx, collapsedLayers, onToggleLayer } = props;
  const hexRows = formatHexDump(detail.bytes, detail.payloadOffset, detail.wireLen);
  const showPayload = detail.decoded !== null || hexRows !== null;

  return (
    <>
      {detail.layers.map((layer, n) => {
        const collapsed = collapsedLayers?.has(n) ?? false;
        return (
          <LayerSection
            key={n}
            index={n}
            layer={layer}
            collapsed={collapsed}
            capturedIdxLabel={showCapturedIdx && n === 0 ? `#${detail.idx}` : null}
            onToggle={() => onToggleLayer?.(n)}
          />
        );
      })}
      {showPayload ? (
        <PayloadSection idx={detail.idx} decoded={detail.decoded} rows={hexRows} />
      ) : null}
    </>
  );
}

function LayerSection(props: {
  index: number;
  layer: FrameLayer;
  collapsed: boolean;
  capturedIdxLabel: string | null;
  onToggle: () => void;
}): ReactNode {
  const { index, layer, collapsed, capturedIdxLabel, onToggle } = props;
  const malformed = isMalformedLayerSummary(layer.summary);

  return (
    <Box data-testid={`trace-detail-layer-${index}`} sx={{ mb: "4px" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          minHeight: 28,
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={onToggle}
        role="button"
        aria-expanded={!collapsed}
        data-testid={`trace-detail-layer-toggle-${index}`}
      >
        <IconButton
          size="small"
          aria-label={collapsed ? "Expand layer" : "Collapse layer"}
          sx={{ p: "2px", color: "text.secondary", transition: "none" }}
          tabIndex={-1}
        >
          <ExpandMoreIcon
            sx={{
              fontSize: 16,
              transform: collapsed ? "rotate(-90deg)" : "none",
            }}
          />
        </IconButton>
        <Typography
          component="span"
          sx={{ fontSize: 13, fontWeight: 500, color: "text.primary", flexShrink: 0 }}
        >
          {layer.protocol}
        </Typography>
        {capturedIdxLabel ? (
          <Typography
            component="span"
            data-testid="trace-detail-captured-idx"
            sx={{ ...MONO, fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0 }}
          >
            {capturedIdxLabel}
          </Typography>
        ) : null}
        <Typography
          component="span"
          data-testid={`trace-detail-layer-summary-${index}`}
          sx={{
            fontSize: 13,
            color: malformed ? "var(--error)" : "text.secondary",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {layer.summary}
        </Typography>
      </Box>
      {collapsed
        ? null
        : layer.fields.map((field, fi) => (
            <Box
              key={`${field.name}-${field.offset}-${fi}`}
              data-testid={`trace-detail-field-${index}-${fi}`}
              sx={{
                display: "flex",
                alignItems: "center",
                height: 28,
                pl: "28px",
                pr: "4px",
                gap: "12px",
                boxSizing: "border-box",
              }}
            >
              <Typography
                component="span"
                sx={{
                  fontSize: 13,
                  color: "text.secondary",
                  flex: "0 1 180px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {field.name}
              </Typography>
              <Typography
                component="span"
                sx={{
                  ...MONO,
                  color: "text.primary",
                  flex: "1 1 auto",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {field.value}
              </Typography>
              <Typography
                component="span"
                data-testid={`trace-detail-field-extent-${index}-${fi}`}
                sx={{
                  ...MONO,
                  fontSize: 12,
                  color: "var(--text-tertiary)",
                  flexShrink: 0,
                  marginLeft: "auto",
                }}
              >
                {formatFieldExtent(field.offset, field.len)}
              </Typography>
            </Box>
          ))}
    </Box>
  );
}

const DECODED_COLS: { id: string; label: string; width: string; align: "left" | "right"; mono: boolean }[] = [
  { id: "name", label: "Name", width: "32%", align: "left", mono: false },
  { id: "rawHex", label: "Raw hex", width: "18%", align: "right", mono: true },
  { id: "rawDec", label: "Raw dec", width: "18%", align: "right", mono: true },
  { id: "scaled", label: "Scaled", width: "22%", align: "right", mono: true },
  { id: "unit", label: "Unit", width: "10%", align: "right", mono: true },
];

function PayloadSection(props: {
  idx: number;
  decoded: DecodedSignal[] | null;
  rows: HexDumpRow[] | null;
}): ReactNode {
  const { idx, decoded, rows } = props;
  return (
    <Box data-testid="trace-detail-payload" sx={{ mt: "4px" }}>
      <Typography
        sx={{ fontSize: 13, fontWeight: 500, color: "text.primary", minHeight: 28, display: "flex", alignItems: "center" }}
      >
        Payload
      </Typography>
      {decoded !== null ? <DecodedTable idx={idx} signals={decoded} /> : null}
      {rows
        ? rows.map((row) => (
            <Box
              key={row.offsetLabel}
              data-testid={`trace-detail-hex-${row.offsetLabel}`}
              sx={{
                display: "flex",
                alignItems: "center",
                height: 28,
                gap: "16px",
                ...MONO,
                color: "text.primary",
              }}
            >
              <Box component="span" sx={{ color: "var(--text-tertiary)", flexShrink: 0 }}>
                {row.offsetLabel}
              </Box>
              <Box component="span">{row.hex}</Box>
            </Box>
          ))
        : null}
    </Box>
  );
}

/** SRS §5.2 five-column decoded signal table (catalog-known events only). */
function DecodedTable(props: { idx: number; signals: readonly DecodedSignal[] }): ReactNode {
  const { idx, signals } = props;
  return (
    <Box
      data-testid={`trace-decoded-${idx}`}
      sx={{ width: "100%", mb: "4px", boxSizing: "border-box" }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          height: 28,
          borderBottom: "1px solid var(--border)",
          boxSizing: "border-box",
        }}
      >
        {DECODED_COLS.map((col) => (
          <Typography
            key={col.id}
            component="span"
            sx={{
              width: col.width,
              flexShrink: 0,
              fontSize: 12,
              fontWeight: 500,
              color: "text.secondary",
              textAlign: col.align,
              pr: col.align === "right" ? "8px" : 0,
              pl: col.align === "left" ? "4px" : 0,
              boxSizing: "border-box",
            }}
          >
            {col.label}
          </Typography>
        ))}
      </Box>
      {signals.map((sig, i) => (
        <Box
          key={`${sig.name}-${i}`}
          data-testid={`trace-decoded-row-${i}`}
          sx={{
            display: "flex",
            alignItems: "center",
            height: 28,
            boxSizing: "border-box",
          }}
        >
          <Typography
            component="span"
            sx={{
              width: "32%",
              flexShrink: 0,
              fontSize: 13,
              color: "text.secondary",
              textAlign: "left",
              pl: "4px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              boxSizing: "border-box",
            }}
          >
            {sig.name}
          </Typography>
          <Typography
            component="span"
            sx={{
              ...MONO,
              width: "18%",
              flexShrink: 0,
              color: "text.primary",
              textAlign: "right",
              pr: "8px",
              boxSizing: "border-box",
            }}
          >
            {sig.rawHex}
          </Typography>
          <Typography
            component="span"
            sx={{
              ...MONO,
              width: "18%",
              flexShrink: 0,
              color: "text.primary",
              textAlign: "right",
              pr: "8px",
              boxSizing: "border-box",
            }}
          >
            {sig.rawDec}
          </Typography>
          <Typography
            component="span"
            data-testid={`trace-decoded-scaled-${i}`}
            sx={{
              ...MONO,
              width: "22%",
              flexShrink: 0,
              color: "text.primary",
              textAlign: "right",
              pr: "8px",
              boxSizing: "border-box",
            }}
          >
            {formatScaled(sig.scaled)}
          </Typography>
          <Typography
            component="span"
            data-testid={`trace-decoded-unit-${i}`}
            sx={{
              ...MONO,
              width: "10%",
              flexShrink: 0,
              color: "text.secondary",
              textAlign: "right",
              pr: "8px",
              boxSizing: "border-box",
            }}
          >
            {sig.unit}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Fetches dissection for `idx` once on mount. Remount (re-expand) to refetch;
 * unmount on collapse discards state.
 */
export function TraceDetailPanel(props: {
  idx: number;
  showCapturedIdx?: boolean;
  /** Test seam — defaults to `fetchFrameDetail`. */
  loadDetail?: (idx: number) => Promise<FrameDetail>;
}): ReactNode {
  const { idx, showCapturedIdx, loadDetail = fetchFrameDetail } = props;
  const [state, setState] = useState<TraceDetailViewState>({ status: "loading" });
  const [collapsedLayers, setCollapsedLayers] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setCollapsedLayers(new Set());
    void loadDetail(idx)
      .then((detail) => {
        if (!cancelled) setState({ status: "ready", detail });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: frameDetailErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [idx, loadDetail]);

  return (
    <TraceDetailBody
      idx={idx}
      state={state}
      showCapturedIdx={showCapturedIdx}
      collapsedLayers={collapsedLayers}
      onToggleLayer={(n) => {
        setCollapsedLayers((prev) => {
          const next = new Set(prev);
          if (next.has(n)) next.delete(n);
          else next.add(n);
          return next;
        });
      }}
    />
  );
}
