declare module 'three/examples/jsm/loaders/usd/USDAParser.js' {
  export class USDAParser {
    parseData(text: string): {
      specsByPath: Record<string, { specType: number; fields: Record<string, any> }>;
    };
    parseText(text: string): Record<string, any>;
  }
}
declare module 'three/examples/jsm/loaders/usd/USDCParser.js' {
  export class USDCParser {
    parseData(data: ArrayBuffer): {
      specsByPath: Record<string, { specType: number; fields: Record<string, any> }>;
    };
  }
}
declare module 'three/examples/jsm/loaders/usd/USDComposer.js' {
  import type { Group, Mesh, Object3D } from 'three';
  export class USDComposer {
    assets: Record<string, any>;
    externalVariantSelections: Record<string, string>;
    specsByPath: Record<string, { specType: number; fields: Record<string, any> }>;
    _buildHierarchy(parent: Object3D, path: string): void;
    _findSingleMesh(group: Group): Mesh | null;
    _resolveReference(reference: string, variants?: Record<string, string>): Group | null;
    compose(
      data: { specsByPath: Record<string, { specType: number; fields: Record<string, any> }> },
      assets?: Record<string, unknown>,
      variants?: Record<string, string>,
      basePath?: string,
    ): Group;
  }
}
