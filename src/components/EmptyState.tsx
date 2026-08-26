import { Box } from "@mui/material";

/**
 * The single empty-state form (SRS_visual_ui.md §7.3): one line of 14 px
 * text-secondary at 50% opacity stating the condition and the action that
 * resolves it. `inset` places it 12 px from the top-left (chart panes, so the
 * axes stay visible and the region stays droppable); default centers in lists.
 */
export function EmptyState(props: { text: string; inset?: boolean; testId?: string }) {
  const { text, inset, testId } = props;
  return (
    <Box
      data-testid={testId}
      sx={{
        fontSize: 14,
        color: "text.secondary",
        opacity: 0.5,
        pointerEvents: "none",
        ...(inset
          ? { position: "absolute", top: 12, left: 12 }
          : { display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }),
      }}
    >
      {text}
    </Box>
  );
}
