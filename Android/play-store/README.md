# Google Play Store listing assets

Everything here is Play Console *listing* content — copy-pasted into the Play Console UI by
hand for now (see the main setup notes for why: CI builds the signed `.aab`, but publishing to
a track is still a manual upload). Nothing here is read by any build script.

## listing/

- `title.txt` — app title (30 char max)
- `short-description.txt` — 69/80 chars
- `full-description.txt` — 2870/4000 chars

## graphics/

- `icon-512.png` — 512×512, 32-bit PNG with alpha. Copied straight from
  `public/icons/android-chrome-512x512.png` — the app's existing icon, already the right size.
- `feature-graphic-1024x500.png` — the banner shown at the top of the store listing. Generated
  from the app icon + brand colours; regenerate by editing the SVG this was rendered from if you
  want to tweak it (ask Claude, or hand-edit and re-render with any SVG→PNG tool at
  1024×500, 24-bit, no alpha).
- `phone-screenshots/*.png` — the existing `docs/screenshots/mobile/*.png` shots, padded
  (not cropped) to a 650×1280 canvas in the app's `#1a1a2e` brand colour. The originals are
  576×1280 — a 2.22:1 ratio, which exceeds Play's "max dimension can't be more than 2× the min
  dimension" rule and would be rejected on upload as-is. Padding fixes the ratio without losing
  any UI content. Play accepts 2–8 phone screenshots; all 4 here are usable.

## What's NOT included — and why

**Tablet (7"/10"), Chromebook, and Android XR screenshots** are all optional in Play Console —
only phone screenshots are required to publish. None are included here because there's no
authentic screenshot of Codexa running on those form factors to draw from (no tablet/Chromebook/
XR device or emulator available in this environment), and stretching the phone screenshots to
fill a tablet frame would misrepresent the UI — Codexa's layout genuinely changes at larger
sizes (two-page spread, wider settings panels, etc. — see the "Display size" and "Two-page
spread" features).

If you want these later, the easiest real path: Codexa's reader is a responsive web app inside
a thin native wrapper, so you can capture legitimate tablet-sized screenshots just by resizing a
desktop browser window to a tablet resolution (e.g. 1600×2560 for 10", 1200×1920 for 7") and
screenshotting the actual running site — no physical tablet or emulator needed.

## Privacy policy

Required by Play Console, hosted separately: `docs/privacy.html`, served via GitHub Pages once
pushed to `main` (same mechanism as the rest of `docs/`).
