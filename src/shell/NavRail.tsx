import { Box, ButtonBase, Tooltip, Typography } from "@mui/material";
import InfoIcon from "@mui/icons-material/Info";
import { VIEWS } from "./viewRegistry";

const COLLAPSED = 65;
const EXPANDED = 240;

/**
 * Navigation rail (SRS_visual_ui.md §4.4): 65/240 px, surface-raised, 1 px
 * right border. The 225 ms width transition is one of the product's only
 * permitted animations (§8). Labels stay in the accessibility tree at zero
 * opacity when collapsed; tooltips appear only when collapsed.
 */
export function NavRail(props: {
  expanded: boolean;
  activeViewId: string;
  onNavigate: (viewId: string) => void;
  onAbout: () => void;
}) {
  const { expanded, activeViewId, onNavigate, onAbout } = props;

  const entry = (opts: {
    id: string;
    label: string;
    icon: React.ReactNode;
    selected?: boolean;
    onClick: () => void;
  }) => (
    <Tooltip key={opts.id} title={expanded ? "" : opts.label} placement="right">
      <ButtonBase
        onClick={opts.onClick}
        aria-label={opts.label}
        aria-current={opts.selected ? "page" : undefined}
        data-testid={`nav-${opts.id}`}
        sx={{
          height: 48,
          px: "20px",
          justifyContent: "flex-start",
          width: "100%",
          bgcolor: opts.selected ? "var(--fill-subtle)" : "transparent",
          color: opts.selected ? "var(--accent-primary)" : "var(--text-secondary)",
          "&:hover": { bgcolor: "var(--fill-subtle)" },
        }}
      >
        <Box sx={{ display: "inline-flex", width: 24, flexShrink: 0 }}>{opts.icon}</Box>
        <Typography
          noWrap
          sx={{
            ml: "24px",
            fontSize: 16,
            color: "inherit",
            opacity: expanded ? 1 : 0,
            transition: "opacity 225ms cubic-bezier(0.4, 0, 0.6, 1)",
            "@media (prefers-reduced-motion: reduce)": { transition: "none" },
          }}
        >
          {opts.label}
        </Typography>
      </ButtonBase>
    </Tooltip>
  );

  return (
    <Box
      component="nav"
      aria-label="Primary"
      data-testid="nav-rail"
      sx={{
        width: expanded ? EXPANDED : COLLAPSED,
        transition: "width 225ms cubic-bezier(0.4, 0, 0.6, 1)",
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
        flexShrink: 0,
        bgcolor: "background.paper",
        borderRight: "1px solid var(--border)",
        overflowX: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {VIEWS.map((v) =>
        entry({
          id: v.id,
          label: v.label,
          icon: <v.icon fontSize="small" />,
          selected: v.id === activeViewId,
          onClick: () => onNavigate(v.id),
        }),
      )}
      <Box sx={{ flex: 1 }} />
      {entry({
        id: "about",
        label: "About",
        icon: <InfoIcon fontSize="small" />,
        onClick: onAbout,
      })}
    </Box>
  );
}
