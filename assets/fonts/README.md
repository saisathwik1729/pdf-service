# Fonts

Noto Sans (Regular/Medium/SemiBold/Bold), SIL Open Font License 1.1 —
https://github.com/notofonts/latin-greek-cyrillic

Fonts are pinned in the repo and installed into the image (see Dockerfile) instead
of relying on whatever the base image ships, because:

1. **Byte-stable layout.** Different font versions change glyph widths, which moves
   page breaks. Same data must produce the same pages in dev and prod.
2. **TrueType, not CFF.** Chromium/Skia embeds OpenType-CFF fonts (e.g. the Inter
   .otf we started with) as Type 3 glyph procedures. Those are larger, render worse
   in some viewers and extract text poorly. TrueType (glyf) fonts embed as proper
   subset CID fonts.
3. **₹ (U+20B9) coverage.** Noto Sans includes the rupee sign; several common
   system fallbacks (e.g. Liberation Sans) do not.
4. **No network at render time.** Pages are rendered with all network blocked.
