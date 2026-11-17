# Tesseract

Read [STYLE_GUIDE.md](STYLE_GUIDE.md) before changing a viewer. Use short labels, host theme tokens, and the shared icons.

Validate changes with `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:browser`. Follow the file handoff and verify the rendered preview when editing format or plugin registration.

Keep file reads scoped to the configured roots or a user-selected file. Package only the files and fixtures explicitly listed by the release script. Machine-specific Codex Bridge procedures live in the ignored `.codex/TESSERACT_LOCAL.md` on the maintainer’s Mac.
