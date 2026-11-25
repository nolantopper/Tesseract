<img src="assets/logo.svg" alt="Tesseract logo" width="64" height="64" align="right">

# Tesseract

Preview local 3D models, archives, media, and robotics recordings beside your Codex chat. Orbit a model, browse a ZIP, or share a frame from an MCAP recording.

![Tesseract previewing a bearing bracket](assets/preview.png)

## Install in Codex Desktop

You’ll need [Codex Desktop](https://developers.openai.com/codex/app), the [Codex CLI](https://developers.openai.com/codex/cli), and [Node.js 22 or later](https://nodejs.org/).

1. Unzip the Tesseract release and open a terminal in the extracted `tesseract` folder.
2. Run both commands. The ZIP already contains the built app and its runtime dependencies.

   ```sh
   codex plugin marketplace add .
   codex plugin add tesseract@tesseract-local
   ```

3. Reopen Codex and start a local chat. Ask **“Open Tesseract so I can choose a file.”** Select **Open file** or drop a file onto the panel. Try the included `samples/bracket.glb` for a first preview.

You can also open a supported workspace file from Codex and select **Open with Tesseract** if prompted. Formats such as MP4, PNG, PDF, and source code can use Codex’s built-in viewers.

## Work on a file with Codex

Double-click a model part or other preview to share it with chat, then ask about it. Double-click a recording frame, timeline, or decoded message to include its exact timestamp. If the host can’t attach the preview, use **Copy reference** and paste it into the chat.

Double-click or double-tap parts to add them to chat. Each addition accumulates in the shared selection. Double-click a shared part again to remove it. Shift-click to select a group, then double-click a selected part to add the whole group. Removing the context with × in Codex clears its highlights. Shared models refresh their highlighted preview image when parts are added, removed, or recolored. Codex can use the image and object IDs to work with unnamed parts.

- **GLB.** Open `samples/bench-vise.glb` to try selecting several named parts. Shift-click to add or remove a part. Double-click or double-tap a selected part to share the group with chat. Shared parts have a translucent fill. Single clicks, background clicks, and Escape change the selection in the viewer.
- **MCAP.** Pick a camera or graph from the topic table. Ask Codex to show every topic or arrange a custom set of cameras, graphs, and messages on one playhead. Graphs support numeric JSON and Foxglove pose topics in indexed recordings. Double-click a frame, point, or message to share its exact timestamp.
- **ZIP and folders.** Navigate with breadcrumbs or the arrow keys. Search ZIPs across paths and preview a single entry without extracting the archive. Select and share models inside archives in the same way as standalone models.
- **Point clouds.** Points use the Codex accent color and stay 3 px wide as you zoom.
- **Fullscreen.** Where the host supports resizing, use the expand icon or press **F**, then the collapse icon or **Escape** to return. Codex native file panels currently stay in the sidebar and do not expose this control.
- **Simulation assets.** Open `samples/simulation` for USD workcells, URDF robots, SDF worlds, and MuJoCo scenes. Orbit, pan, zoom, and double-click named parts to share their visual context. Open the containing workspace folder or ZIP to resolve linked meshes, layers, and buffers.

## Edit the open file

Open the file directly in the Codex sidebar. Where a format and file support an edit, the panel shows an edit control next to the selection or preview. Save writes the original file through Codex and updates the open preview. Native panels refresh on file-change notifications when Codex supports them. Older hosts check for workspace revisions or reread versioned native files at a rate based on file size, up to the usual preview limit. If a save hits a conflict, wait for the refresh or reopen the file before trying again. The file must have a writable Codex resource and fit within the 64 MiB save limit. Some editors have lower limits or require a specific encoding. Picker files and nested archive entries are preview sessions. GLB preview recolors can be exported with **Save copy** where the host supports downloads.

| Files                                                       | In-place edit                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GLB, glTF                                                   | Recolor a selected part. A solid recolor replaces its base color texture.                                                                                                                                                            |
| STEP/STP                                                    | Recolor a supported CAD face. Hold Option or Alt and click the face. Up to 8 MiB.                                                                                                                                                    |
| STL, OBJ, PLY, PCD                                          | Rotate supported geometry by 90°. Up to 8 MiB. PCD requires ASCII or uncompressed binary with no stored viewpoint.                                                                                                                   |
| MCAP                                                        | Rename a channel without changing its message payloads or timestamps.                                                                                                                                                                |
| ZIP, NPZ, TAR, GZ/GZIP/TGZ                                  | Rename supported entries. GZIP edits the stored filename.                                                                                                                                                                            |
| SQLite                                                      | Update a text or numeric value in a supported standalone table.                                                                                                                                                                      |
| GeoJSON, KML                                                | Rename a feature or placemark.                                                                                                                                                                                                       |
| NPY, classic NetCDF, HDF5                                   | Change a supported scalar array element.                                                                                                                                                                                             |
| ONNX, TFLite, Safetensors, GGUF                             | Edit the model description. TFLite needs an existing description field.                                                                                                                                                              |
| PNG, JPEG, WebP, GIF, SVG                                   | Rotate via stored orientation (PNG, JPEG), rotate and re-encode supported static WebP, change GIF animation timing, or set the SVG background.                                                                                       |
| TIFF, PSD, Radiance HDR, OpenEXR, DICOM, NIfTI, NRRD        | Rotate a classic TIFF page via orientation, darken the layers and composite of a supported 8-bit RGB PSD, adjust RGB exposure in supported HDR/EXR, invert uncompressed grayscale DICOM, or adjust NIfTI/NRRD intensity calibration. |
| MOV/QT, MP4, M4V, MKV, MKA, WebM, WEBA, MP3, WAV, OGG, FLAC | Trim supported tracks with codec-copy output. Available cut points depend on the tracks.                                                                                                                                             |
| UTF-8 text                                                  | Edit text up to 256 KiB.                                                                                                                                                                                                             |

The other formats below are currently preview-only in Tesseract. Codex’s native registration determines which editor receives a file.

## What you can preview

| Files                                                                    | Preview                                                                                         |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| STL, GLB, glTF, OBJ, PLY, PCD                                            | Orbit, pan, zoom, and part selection                                                            |
| STEP/STP, IGES/IGS, LAS/LAZ, VTK/VTU/VTP                                 | CAD geometry, point clouds, and supported scientific meshes                                     |
| USD, USDA, USDC, USDZ                                                    | Static meshes, primitives, points, transforms, material colors, and supported layer composition |
| URDF, SDF/world, MJCF, MuJoCo XML                                        | Static robot and world geometry, named parts, link transforms, and supported linked meshes      |
| Collada DAE                                                              | Geometry, material colors, and accessible image textures                                        |
| 3MF, AMF, FBX, 3DS, 3DM, BREP, DXF, IFC                                  | Static 3D geometry and DXF layers with orbit, selection, and visual chat context                |
| ZIP, TAR, GZ/GZIP/TGZ, NPZ, APK, CBZ, EAR, EPUB, IPA, JAR, KMZ, WAR, WHL | Browse entries and preview their contents                                                       |
| 7z, RAR, XZ, BZ2, ZST, ISO, CAB                                          | Browse archive entries and preview compressed files                                             |
| MCAP, ROS1 BAG                                                           | Recording metadata, sampled messages, and supported MCAP camera playback                        |
| NPY, H5/HDF5, NC/NetCDF, E57                                             | Array data, dataset metadata, and E57 scan headers                                              |
| Parquet, SQLite                                                          | Table browsing, page filters, and shareable rows                                                |
| GeoJSON, KML, Shapefile                                                  | Offline feature maps and selectable attributes                                                  |
| TIFF/GeoTIFF, PSD, EXR, HDR                                              | Selectable pages, image bands, layers, and channels                                             |
| DICOM, NIfTI, NRRD                                                       | Uncompressed DICOM frames and orthogonal slices of scalar volumes                               |
| ONNX, TFLite, Safetensors, GGUF                                          | Inspect graph operators, tensor shapes, and supported metadata                                  |
| MOV/QT, M4V, MKV, 3GP/3G2, WEBA, MKA                                     | Video and audio playback when the host supports the codec                                       |
| AVI, MPEG, WMV, FLAC, AIFF                                               | Host playback or local FFmpeg preview, with shareable playback positions                        |
| MP4, WebM, MP3, WAV, OGG, PNG, JPEG, WebP, GIF, SVG, AVIF                | Media previews are also available through Tesseract’s file picker                               |
| Plain text and other files                                               | Text preview for readable UTF-8. Hexadecimal preview for unrecognized binaries.                 |

Most decoded previews cap input at 64 MiB. ZIPs and NPZs list up to 2,000 entries by reading the index, then load up to 64 MiB for the selected entry. Other archives cap the full expanded preview and omit links and special files. Model dependencies are limited to 64 files and 64 MiB total, read only from configured workspace roots or the opened archive. Standalone picker files need embedded assets. Large indexed MCAPs read a bounded camera window. Use **Open file** or drag and drop for a large file outside the configured workspace roots if the Codex file handoff reaches its size limit. E57 shows metadata, and the VTK viewer supports legacy POLYDATA and a subset of ASCII XML meshes.

For codecs the host cannot play, a local FFmpeg installation can convert the first 20 seconds from files up to 4 MiB. Set the MCP server's \`TESSERACT_FFMPEG\` environment variable to the absolute path if FFmpeg is outside its PATH. The output is a temporary preview. Video conversion uses H.264 and AAC, and audio conversion uses Opus.

The CAD importers show static geometry with supported materials. Rhino surfaces need stored render meshes. DXF previews cover common ASCII drawing entities grouped by layer. 3MF supports single-model packages. The Photoshop viewer displays stored composites and layer bitmaps. DICOM previews uncompressed frames and shares frame descriptions with chat. ONNX and TFLite expose operator connections in the inspection table, and Safetensors and GGUF expose metadata without loading tensor weights. Shapefile companions and detached NRRD data resolve within the containing folder or archive.

In a focused 3D preview, press **0** for perspective, **1** for front, **2** for right, **3** for back, **4** for left, **5** for top, or **6** for bottom. **Home** fits the model.

Option-click (Alt-click on Windows or Linux) selects a face in a mesh. Option-double-click adds or removes it from chat. Shared context includes the parent part, face index, hit coordinates, and surface normal.

Drag a movable link to pose hinge and slide joints in URDF, SDF link trees, and MuJoCo models. Drag the background to orbit. On the focused viewport, press Page Up or Page Down to choose a joint, use the arrow keys to move it, and press R to reset the pose. Chat can read the pose and move a joint with `set_joint`, in radians or meters, while the model is shared. Limits come from the file. Unbounded joints have a finite preview range. Simulation previews are kinematic, without physics, controllers, or plugins.

USD image textures use material colors and animations use their initial pose. Robot mesh imports preserve geometry and colors. Linked mesh image textures are omitted. Xacro and procedural MuJoCo models require preprocessing. Unsupported SDF placement frames, merged includes, scoped frames, and heightmaps report a specific error. MuJoCo `.xml` content is recognized through **Open file** or a folder preview. Ordinary XML keeps its Codex editor.

## Workspace access

Files picked or dropped into the panel are read by the viewer. For indexed inspection and agent-visible selections, explicitly grant the server a workspace folder. From the extracted package, run the commands below, then reopen Codex.

```sh
node scripts/configure-plugin.mjs "/path/to/project"
codex plugin add tesseract@tesseract-local
```

Repeat the path argument to add more roots. The bundled configuration grants server-side access to the included samples. Double-click to share the open preview with Codex, including files opened from the picker. Tesseract runs in the Codex side panel and communicates with its MCP server over standard input and output. Archive previews run in memory.

## Develop

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and how a file reaches its viewer. `npm run release` writes the install ZIP and SHA-256 checksum to `release/`.

Tesseract’s source is available under the [MIT license](LICENSE). Bundled dependencies retain the licenses listed in [third-party notices](THIRD_PARTY.md).
