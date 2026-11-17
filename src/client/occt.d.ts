declare module 'occt-import-js' {
  interface CadMesh {
    name: string;
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }
  interface CadResult {
    success: boolean;
    meshes: CadMesh[];
  }
  export default function init(options: { wasmBinary: ArrayBuffer }): Promise<{
    ReadStepFile(data: Uint8Array, options: unknown): CadResult;
    ReadIgesFile(data: Uint8Array, options: unknown): CadResult;
  }>;
}
