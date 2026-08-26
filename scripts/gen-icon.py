"""RadEAU icon generator — geometric mark: R + wave + raft (red/dark/white).

Icon-craft rules: flat colors, few bold shapes, readable at 16 px. Drawn at 4x
supersampling with PIL, downscaled to 1024. Outputs app-icon.png (icon source)
and src/assets/radeau-mark.png (in-app mark).

Run: python scripts/gen-icon.py [--preview-only]
"""

import sys

from PIL import Image, ImageDraw

SS = 4  # supersampling factor
S = 1024 * SS

RED = (208, 32, 46, 255)
DARK = (20, 12, 14, 255)
WHITE = (250, 250, 251, 255)


def rounded_bar(d, x0, y0, x1, y1, color):
    """Axis-aligned bar with fully rounded ends."""
    d.rounded_rectangle((x0, y0, x1, y1), radius=min(x1 - x0, y1 - y0) / 2, fill=color)


def thick_line(d, p0, p1, w, color):
    """Thick line with round caps."""
    d.line([p0, p1], fill=color, width=w)
    r = w / 2
    for (x, y) in (p0, p1):
        d.ellipse((x - r, y - r, x + r, y + r), fill=color)


def draw_mark(scale=1.0):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = SS * scale  # unit: 1 px at 1024 base times overall scale
    cx = cy = S / 2

    # Flat red disc, full bleed
    r_disc = 500 * SS
    d.ellipse((cx - r_disc, cy - r_disc, cx + r_disc, cy + r_disc), fill=RED)

    # --- The R (white, bold): solid bowl fused to the stem, wave-swoosh leg ---
    stroke = 96 * u
    bx, by = cx - 55 * u, cy - 125 * u
    r_out = 165 * u
    r_in = r_out - stroke

    stem_x0 = cx - 250 * u
    stem_top = by - r_out  # flush with the bowl top — no step
    stem_bot = cy + 140 * u

    # Stem, then bowl: filled outer circle + bridge to the stem, then carve
    # the counter (inner hole) back to red — a clean D-bowl.
    rounded_bar(d, stem_x0, stem_top, stem_x0 + stroke, stem_bot, WHITE)
    d.ellipse((bx - r_out, by - r_out, bx + r_out, by + r_out), fill=WHITE)
    d.rectangle((stem_x0 + stroke / 2, by - r_out, bx, by + r_out), fill=WHITE)
    d.ellipse((bx - r_in, by - r_in, bx + r_in, by + r_in), fill=RED)
    # re-carve the counter between stem and bowl center
    d.rectangle((stem_x0 + stroke, by - r_in, bx, by + r_in), fill=RED)

    # Wave leg: thick S-swoosh from the bowl junction to bottom-right,
    # sampled from a cubic bezier, round-capped.
    p0 = (cx - 110 * u, cy + 5 * u)
    c1 = (cx - 20 * u, cy + 135 * u)
    c2 = (cx + 130 * u, cy + 185 * u)
    p3 = (cx + 235 * u, cy + 95 * u)
    prev = p0
    for i in range(1, 25):
        t = i / 24
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * c1[0] + 3 * mt * t**2 * c2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * c1[1] + 3 * mt * t**2 * c2[1] + t**3 * p3[1]
        thick_line(d, prev, (x, y), int(stroke * 0.92), WHITE)
        prev = (x, y)

    # --- The raft (dark logs), staggered, clear of the disc edge ---
    log_h = 62 * u
    gap = 24 * u
    y0 = cy + 218 * u
    widths = (255 * u, 295 * u, 215 * u)
    for i, w in enumerate(widths):
        yy = y0 + i * (log_h + gap)
        rounded_bar(d, cx - w, yy, cx + w, yy + log_h, DARK)

    return img.resize((1024, 1024), Image.LANCZOS)


def sheet(variants, path):
    BG = (13, 17, 23, 255)
    CELL, PAD = 84, 14
    W = PAD + len(variants) * (CELL + PAD)
    H = PAD + 30 + 3 * (CELL + PAD) + 110
    sh = Image.new("RGBA", (W, H), BG)
    sd = ImageDraw.Draw(sh)
    for col, (name, v) in enumerate(variants.items()):
        x0 = PAD + col * (CELL + PAD)
        sd.text((x0 + CELL // 2 - 8, PAD), name, fill=(230, 237, 243, 255))
        for row, s in enumerate([48, 32, 16]):
            y0 = PAD + 30 + row * (CELL + PAD)
            small = v.resize((s, s), Image.LANCZOS)
            sh.paste(small.resize((CELL, CELL), Image.NEAREST), (x0, y0), small.resize((CELL, CELL), Image.NEAREST))
        prev = v.resize((96, 96), Image.LANCZOS)
        sh.paste(prev, (x0, PAD + 30 + 3 * (CELL + PAD)), prev)
    sh.save(path)


if __name__ == "__main__":
    mark = draw_mark()
    if "--preview-only" in sys.argv:
        out = sys.argv[sys.argv.index("--preview-only") + 1]
        mark.save(out + "/icon-geo.png")
        sheet({"GEO": mark}, out + "/icon-geo-sheet.png")
        print("preview written to", out)
    else:
        mark.save("app-icon.png")
        mark.resize((512, 512), Image.LANCZOS).save("src/assets/radeau-mark.png")
        print("app-icon.png + src/assets/radeau-mark.png written")
