import { Box } from "@mui/material";
import { useEffect, useRef } from "react";
import { VIEWS } from "./viewRegistry";
import { resumeView, suspendView } from "./viewLifecycle";

/**
 * Keep-alive view host (PRD §3.6, decision D4): every view mounts once and
 * hides with display:none — graphics contexts and scroll positions survive
 * navigation. Two-phase navigation: the visible shell flips immediately;
 * suspend/resume fires only after paint (double animation frame + zero
 * timeout). A hidden view reports zero size, so view layout math must guard
 * against it (SRS_visual_ui.md §4.5).
 */
export function ViewHost(props: { activeViewId: string }) {
  const { activeViewId } = props;
  const previousRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (cancelled) return;
          const previous = previousRef.current;
          if (previous && previous !== activeViewId) suspendView(previous);
          resumeView(activeViewId);
          previousRef.current = activeViewId;
        }, 0);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeViewId]);

  return (
    <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
      {VIEWS.map((v) => {
        const active = v.id === activeViewId;
        return (
          <Box
            key={v.id}
            data-testid={`view-${v.id}`}
            sx={{
              display: active ? "flex" : "none",
              flexDirection: "column",
              height: "100%",
              overflow: "auto",
              p: v.fullBleed ? 0 : "24px",
              bgcolor: "var(--surface-canvas)",
            }}
          >
            <v.component />
          </Box>
        );
      })}
    </Box>
  );
}
