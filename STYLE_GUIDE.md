# Tesseract Style Guide

Tesseract should feel at home in the Codex side panel. Give the artifact the most space, keep controls close to what they affect, and use text only when it helps someone identify a file, take an action, or understand a result. Use the MCAP camera viewer as the reference for new panels.

## Layout

- Use Codex’s native breadcrumbs for file identity. Omit an internal header, filename, format badge, and open-file button once a file is displayed. Keep the file picker in the empty state and allow drag and drop.
- Share context through double-clicks. Keep fullscreen on the expand control and its keyboard shortcut. Float the save-copy icon over the preview only when edits can be exported. Omit model dimensions and the file-size footer.
- Place the edit icon next to the selection it affects. Open controls on demand and give each save action an accessible label. Show a write error beside the controls so the draft stays available.
- Let 3D models fill the available panel. Use the host background directly and keep camera controls off the canvas.
- Put the preview first. Place view selection above it, direct controls below it, and technical details farther down. Use spacing and subtle dividers to group related elements. Reserve raised surfaces for menus and floating controls.
- Put the title first inside titled preview panes, using the same header for video, graphs, and messages. Use the browser’s native controls for audio and video. In MCAP, use the same preview height and playhead for video and graphs. Give multiple panes one playback control.
- Use compact panes for an MCAP topic overview. Keep its playback control within reach while the pane grid scrolls.
- Highlight the displayed topics in the table below. Keep the layout when a displayed topic is selected again. Keep fields, values, and axes readable at narrow widths. Double-click a frame, graph point, or timeline position to share its exact recording timestamp.
- Use the shared dropdown styling for graph fields. Keep play, pause, and scrubbing inside the graph preview. Carry the playhead and play or pause state between video and graphs.
- For decoded recordings, put a full-width scrubber above a compact play button and time readout. Keep the controls attached to the message preview.
- Design for a narrow panel. Keep primary actions within reach and let secondary details wrap, scroll, or move into a disclosure. Keep technical metadata out of the way until it is needed.

## Theme and typography

- Use Codex host tokens for surfaces, text, borders, focus, and corner radius. Start with Tesseract’s shared CSS variables and retain light and dark fallbacks. Use neutral surfaces and reserve strong contrast for the primary action, focus, or a meaningful state.
- Use the host sans serif for interface copy. Use monospace for topic names, paths, and raw values where character alignment helps. Use tabular numerals for changing values such as elapsed time and message counts.

## Icons and controls

- Reuse the shared icon set. Start with the existing 18 px outline icon and 32 px button target. Use familiar symbols such as play, pause, and expand. Keep stroke weight consistent and leave room around the glyph.
- Give every icon button an accessible action name and a short tooltip. Change the name when the action changes, as with “Play recording” and “Pause recording.” Use a visible label when an icon alone would be ambiguous.
- Let the selected field and a chevron identify the graph dropdown. Keep the trigger compact and give the menu enough width for readable options. Use the host surface, highlight the focused option, and mark the selection with a check. Preserve keyboard selection and show a clear focus ring.

## Interface copy

- Keep names, values, units, and action labels. Omit decorative subtitles, repeated headings, and instructions for obvious interactions. A selector showing `/camera` needs no adjacent “Camera” label or camera icon.
- Use short, specific copy for loading, empty, and error states. “Loading camera frames…” is enough while the preview loads. When a problem is recoverable, give the user a direct action such as “Retry file.”

## Before shipping

- Open `test/fixtures/cameras.mcap` in the native Codex panel. Check light and dark themes, a narrow width, long labels, and the open menu. Verify the video remains the largest element and controls stay visible.
- Use the keyboard to select a topic or change a graph field. Check focus, hover, selected, disabled, loading, and error states. Respect reduced motion and give selected states a cue beyond color.
- Play, scrub, switch cameras, and double-click a frame. Confirm chat receives the rendered frame and its exact timestamp.

Implementation references are in the [shared styles](src/client/style.css), [icon set](src/client/Icon.tsx), and [MCAP player](src/client/viewers/McapVideo.tsx).
