declare module 'occt-import-js' {
  interface CadMesh {
    name: string;
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
    color?: [number, number, number];
    brep_faces?: { first: number; last: number; color?: [number, number, number] }[];
  }
  interface CadResult {
    success: boolean;
    meshes: CadMesh[];
  }
  export default function init(options: { wasmBinary: ArrayBuffer }): Promise<{
    ReadStepFile(data: Uint8Array, options: unknown): CadResult;
    ReadIgesFile(data: Uint8Array, options: unknown): CadResult;
    ReadBrepFile(data: Uint8Array, options: unknown): CadResult;
  }>;
}
