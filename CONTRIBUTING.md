# Contributing to Tesseract

Use Node.js 22.12 or later. Run these commands from a source checkout:

```sh
npm ci
npx playwright install chromium
npm run format:check
npm run typecheck
npm run build
npm test
npm run test:browser
```

Run `npm run format` to apply the project's formatting. To open the standalone viewer while working on a change, run `npm run dev -- --web` after the first build.

## Follow a file through the viewer

1. Codex matches the extension in [file-entrypoint.ts](src/shared/file-entrypoint.ts) to a viewer registered by [mcp.ts](src/server/mcp.ts).
2. [backend.ts](src/client/backend.ts) reads the file through the host-supplied resource. Indexed workspace inspection goes through the configured roots enforced by [files.ts](src/server/files.ts). The file picker uses the browser's access to the selected file.
3. [formats.ts](src/shared/formats.ts) identifies the file. [registry.ts](src/client/registry.ts) selects a viewer, which can pass bounded bytes to a worker for parsing. A selection tied to a workspace artifact can be returned to Codex.

For a new format, add a small reproducible fixture and exercise the path a user will take to open it. Follow the [style guide](STYLE_GUIDE.md) for viewer UI changes.

## Camera fixtures

`test/fixtures/cameras.mcap` contains two synthetic H.264 camera feeds. The default camera checks use that fixture. To regenerate it, use Node.js 22.15 or later and FFmpeg with `libx264`:

```sh
npx tsx scripts/generate-camera-fixture.ts
```

Set `TESSERACT_FFMPEG` to an executable path if FFmpeg is outside your PATH. The optional DreamTac regression uses a local file under the Git-ignored `samples/external/` directory. The install ZIP uses the sample allowlist in [package-release.mjs](scripts/package-release.mjs).

## Check the release

Run `npm run release` to build a ZIP and verify its MCP server from an isolated staging directory. For file registration changes, also install that ZIP using the [desktop instructions](README.md#install-in-codex-desktop) and check that Codex opens the format in the native panel.
