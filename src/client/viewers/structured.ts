export interface StructuredRequest {
  table?: string;
  offset?: number;
}

export interface TablePreview {
  tables: string[];
  table?: string;
  columns: { name: string; type?: string }[];
  rows: (string | null)[][];
  edits?: { rowId: string; types: (string | null)[] }[];
  offset: number;
  more: boolean;
  note?: string;
}

export interface SqliteCellEdit {
  table: string;
  column: string;
  rowId: string;
  value: string;
}

export interface ModelItem {
  id: string;
  label: string;
  type?: string;
  shape?: string;
  inputs?: string[];
  outputs?: string[];
  details?: string;
  canEdit?: boolean;
}

export interface MachineModel {
  metadata: ModelItem[];
  graphs: { name: string; operators: ModelItem[]; tensors: ModelItem[] }[];
  note?: string;
}

export type MapPoint = [number, number];
export interface MapFeature {
  id: string;
  label: string;
  canRename?: boolean;
  details: string;
  points: MapPoint[];
  lines: MapPoint[][];
  polygons: MapPoint[][][];
}

export interface MapPreview {
  features: MapFeature[];
  bounds: [number, number, number, number];
  note?: string;
}

export type StructuredOutput = TablePreview | MachineModel | MapPreview;

export type StructuredEdit = { table: SqliteCellEdit } | { description: string };

export type WorkerInput =
  | { kind: 'inspect'; format: string; size: number; request: StructuredRequest }
  | { kind: 'edit'; format: string; size: number; edit: StructuredEdit }
  | { kind: 'bytes'; id: number; data?: ArrayBuffer; error?: string };

export type WorkerOutput =
  | { kind: 'read'; id: number; start: number; length: number }
  | { kind: 'asset'; id: number; extension: string }
  | { kind: 'result'; data: StructuredOutput }
  | { kind: 'edit'; bytes?: Uint8Array; error?: string }
  | { kind: 'error'; error: string };
