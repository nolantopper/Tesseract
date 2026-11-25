declare module 'three/addons/libs/rhino3dm/rhino3dm.module.js' {
  // Three ships its matching decoder but does not publish typings for it.
  export default function init(options: { wasmBinary: ArrayBuffer }): Promise<any>;
}
