# Third-party software

The release contains the dependencies pinned by `package-lock.json`. Their license files and notices are in the corresponding package directories under `node_modules`. These dependencies retain their own licenses.

| Component             | License and source                                                                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| occt-import-js 0.0.23 | LGPL 2.1. The [wrapper source and WASM build scripts](https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2) use [this Open CASCADE source revision](https://github.com/Open-Cascade-SAS/OCCT/tree/d2abb6d844231cb8f29be6894440874a4700e4a5). The installed package contains the LGPL text. |
| laz-perf 0.0.7        | Apache 2.0. [Source and WASM build scripts](https://github.com/hobuinc/laz-perf/tree/d0d3047e05221421fa0b02b3da4e93797edb2c52). [License](licenses/laz-perf.txt).                                                                                                                                                             |
| h5wasm 0.10.3         | The installed package contains the license and HDF5 notices. [Source](https://github.com/usnistgov/h5wasm).                                                                                                                                                                                                                   |

The bundled bearing bracket, bench vise, robotics recording, sample video, and simulation scenes are authored Tesseract fixtures. Downloaded datasets and files used for local testing are excluded from the release.

Additional bundled decoders include [libarchive.js](https://github.com/nika-begiashvili/libarchivejs) and [libarchive](https://github.com/libarchive/libarchive), [XZ Decompress](https://github.com/httptoolkit/xz-decompress), [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (MPL-2.0), and [rhino3dm](https://github.com/mcneel/rhino3dm) from Three.js. FFmpeg conversion uses the user's local executable.

[Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) packages MCAP camera frames into MP4 for playback. Its source and license are included under `node_modules/mediabunny`.

The test-only binary USD fixture comes from [OpenUSD](https://github.com/PixarAnimationStudios/OpenUSD/blob/release/pxr/usdValidation/bin/usdchecker/testenv/testUsdChecker/clean/geom.usdc), under the [Tomorrow Open Source Technology License 1.0](https://github.com/PixarAnimationStudios/OpenUSD/blob/release/LICENSE.txt). Its source metadata and license are retained in `test/fixtures/simulation`; it is excluded from the plugin ZIP.
