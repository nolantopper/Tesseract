# Tesseract Style Guide

Tesseract should feel at home in the Codex side panel. Give the artifact the most space, keep controls close to what they affect, and use text only when it helps someone identify a file, take an action, or understand a result. Use the MCAP camera viewer as the reference for new panels.

## Layout

- Use a slim header with the filename on the left and panel actions on the right. Keep the format badge small when it helps identify the file. Truncate long names visually and keep the full name available.
- Put the preview first. Place view selection above it, direct controls below it, and technical details farther down. Use spacing and subtle dividers to group related elements. Reserve raised surfaces for menus and floating controls.
- In MCAP, place the camera selector just above the video. Use one playback row for play or pause, the scrubber, elapsed and total time, and the flag. Leave the raw timestamp out of the playback layout. Exact time can appear in selection feedback or inspection views where it serves a purpose.
- Design for a narrow panel. Keep primary actions within reach and let secondary details wrap, scroll, or move into a disclosure. Keep technical metadata out of the way until it is needed.

## Theme and typography

- Use Codex host tokens for surfaces, text, borders, focus, and corner radius. Start with Tesseract’s shared CSS variables and retain light and dark fallbacks. Use neutral surfaces and reserve strong contrast for the primary action, focus, or a meaningful state.
- Use the host sans serif for interface copy. Use monospace for topic names, paths, and raw values where character alignment helps. Use tabular numerals for changing values such as elapsed time and message counts.

## Icons and controls

- Reuse the shared icon set. Start with the existing 18 px outline icon and 32 px button target. Use familiar symbols such as play, pause, expand, and flag. Keep stroke weight consistent and leave room around the glyph.
- Give every icon button an accessible action name and a short tooltip. Change the name when the action changes, as with “Play recording” and “Pause recording.” Use a visible label when an icon alone would be ambiguous.
- Let the selected camera channel and a chevron identify the dropdown. Keep the trigger compact and give the menu enough width for readable options. Use the host surface, highlight the focused option, and mark the current camera with a check. Preserve the underlying select’s keyboard behavior and show a clear focus ring.

## Interface copy

- Keep names, values, units, and action labels. Omit decorative subtitles, repeated headings, and instructions for obvious interactions. A selector showing `/camera` needs no adjacent “Camera” label or camera icon.
- Explain a consequence at the point of action. The flag can say “Select timestamp” on hover. After use, acknowledge the selection where the user can see it.
- Use short, specific copy for loading, empty, and error states. “Loading camera frames…” is enough while the preview loads. When a problem is recoverable, give the user a direct action such as “Retry file.”

## Before shipping

- Open `test/fixtures/cameras.mcap` in the native Codex panel. Check light and dark themes, a narrow width, long labels, and the open menu. Verify the video remains the largest element and controls stay visible.
- Use the keyboard to change cameras and dismiss the menu. Check focus, hover, selected, disabled, loading, and error states. Respect reduced motion and give selected states a cue beyond color.
- Play, scrub, switch cameras, and flag a moment. Confirm the recording preserves the selected timestamp even though the playback layout omits the raw value.

Implementation references are in the [shared styles](src/client/style.css), [icon set](src/client/Icon.tsx), and [MCAP player](src/client/viewers/McapVideo.tsx).
