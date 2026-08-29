/**
 * Per-column Trace filter popover (SRS_visual_ui.md §5.2): 250 px, optional
 * search, select-all / selected·total, checkbox list, Cancel / Apply.
 * Apply commits; selecting every option clears that column's filter.
 */

import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Popover,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import type { TraceFilterColumn, TraceFilterOption } from "../runtime/traceFilter";

const HAS_SEARCH: ReadonlySet<TraceFilterColumn> = new Set(["service", "name"]);

export interface TraceFilterPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  column: TraceFilterColumn;
  /** Snapshot of distinct ring values taken when the popover opened. */
  options: readonly TraceFilterOption[];
  /**
   * Committed selection for this column. `null` = unfiltered (everything
   * selected in the draft). String keys — Protocol converts to numbers on Apply.
   */
  committed: ReadonlySet<string> | null;
  onApply: (next: ReadonlySet<string> | null) => void;
  onCancel: () => void;
}

export function TraceFilterPopover(props: TraceFilterPopoverProps) {
  const { open, anchorEl, column, options, committed, onApply, onCancel } = props;
  const showSearch = HAS_SEARCH.has(column);

  const [draft, setDraft] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");

  // Re-seed draft when the popover opens (apply-on-Apply; Cancel discards).
  useEffect(() => {
    if (!open) return;
    if (committed === null) {
      setDraft(new Set(options.map((o) => o.key)));
    } else {
      setDraft(new Set(committed));
    }
    setSearch("");
  }, [open, committed, options]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  const selectedCount = options.reduce(
    (n, o) => n + (draft.has(o.key) ? 1 : 0),
    0,
  );
  const allSelected = options.length > 0 && selectedCount === options.length;

  const toggle = (key: string): void => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = (): void => {
    if (allSelected) {
      setDraft(new Set());
    } else {
      setDraft(new Set(options.map((o) => o.key)));
    }
  };

  const handleApply = (): void => {
    if (options.length > 0 && selectedCount === options.length) {
      onApply(null);
    } else {
      onApply(new Set(draft));
    }
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onCancel}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      transformOrigin={{ vertical: "top", horizontal: "left" }}
    >
      <Box sx={{ width: 250, p: "12px" }} data-testid="trace-filter-popover">
        {showSearch ? (
          <TextField
            size="small"
            fullWidth
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="trace-filter-search"
            sx={{ mb: 1, "& .MuiInputBase-root": { fontSize: 13 } }}
            inputProps={{ "aria-label": "Filter options" }}
          />
        ) : null}

        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 0.5 }}
        >
          <Button
            size="small"
            onClick={toggleSelectAll}
            data-testid="trace-filter-select-all"
            sx={{ fontSize: 12, textTransform: "none", minWidth: 0, px: 0.5 }}
          >
            {allSelected ? "Deselect all" : "Select all"}
          </Button>
          <Typography
            component="span"
            data-testid="trace-filter-count"
            sx={{ fontSize: 12, color: "text.secondary" }}
          >
            {selectedCount} / {options.length}
          </Typography>
        </Stack>

        <Box
          sx={{
            maxHeight: 250,
            overflowY: "auto",
            borderTop: "1px solid var(--border)",
            borderBottom: "1px solid var(--border)",
            mb: 1,
          }}
        >
          {visible.map((o) => (
            <FormControlLabel
              key={o.key}
              data-testid={`trace-filter-option-${o.key}`}
              sx={{
                display: "flex",
                m: 0,
                px: 0.5,
                width: "100%",
                "& .MuiFormControlLabel-label": {
                  fontSize: 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                },
              }}
              control={
                <Checkbox
                  size="small"
                  checked={draft.has(o.key)}
                  onChange={() => toggle(o.key)}
                  sx={{ py: 0.25 }}
                />
              }
              label={`${o.label} (${o.count})`}
            />
          ))}
        </Box>

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            size="small"
            onClick={onCancel}
            data-testid="trace-filter-cancel"
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={handleApply}
            data-testid="trace-filter-apply"
            sx={{ textTransform: "none" }}
          >
            Apply
          </Button>
        </Stack>
      </Box>
    </Popover>
  );
}
