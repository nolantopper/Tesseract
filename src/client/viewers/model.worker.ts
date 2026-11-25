import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Mesh,
  Points,
  type Object3D,
  type BufferAttribute,
} from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

import initCad from 'occt-import-js';
import { VTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js';
import { parseVtkXml } from './vtk-xml';
import { parseLas, parseLaz } from './las';
import { parsePcd } from './pcd';
import { parseUsd } from './usd';
import { parseSimulation } from './simulation';
import { objectFromParts, partsFromObject, disposeModel, type Part } from './model-parts';
import type { Joint } from './model-joints';
import { repaintStepFace, type StepFacePaint } from './step-edits';

export type { Part } from './model-parts';
let nextRequest = 0;
const pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void }>();
function request(type: 'asset' | 'mesh', params: Record<string, unknown>): Promise<any> {
  const requestId = ++nextRequest;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    self.postMessage({ type, requestId, ...params });
  });
}
self.onmessage = async (
  event: MessageEvent<{
    format: string;
    name?: string;
    data: ArrayBuffer;
    wasm?: ArrayBuffer;
    stepPaint?: StepFacePaint;
    requestId?: number;
    error?: string;
    parts?: Part[];
  }>,
) => {
  if (event.data.requestId !== undefined) {
    const callback = pending.get(event.data.requestId);
    pending.delete(event.data.requestId);
    if (event.data.error) callback?.reject(new Error(event.data.error));
    else callback?.resolve(event.data.parts ?? event.data.data);
    return;
  }
  try {
    const { format, data } = event.data;
    if (format === 'step' && event.data.stepPaint) {
      const cad = await initCad({ wasmBinary: event.data.wasm! });
      const bytes = repaintStepFace(new Uint8Array(data), event.data.stepPaint, cad.ReadStepFile);
      self.postMessage({ bytes }, { transfer: [bytes] });
      return;
    }
    const parts: Part[] = [];
    let joints: Joint[] = [];
    const transfer: ArrayBuffer[] = [];
    const add = (geometry: BufferGeometry, name: string, points = false) => {
      const positions = geometry.getAttribute('position');
      if (!positions || positions.count < 1 || positions.count > 6_000_000)
        throw new Error('Model is empty or exceeds the 6 million vertex limit.');
      if (!points && !geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const part: Part = { name, points, attributes: {} };
      for (const key of ['position', 'normal', 'color']) {
        const attr = geometry.getAttribute(key) as BufferAttribute | undefined;
        if (attr) {
          const array = new Float32Array(attr.array);
          part.attributes[key] = { array, itemSize: attr.itemSize };
          transfer.push(array.buffer);
        }
      }
      if (geometry.index) {
        part.index = new Uint32Array(geometry.index.array);
        transfer.push(part.index.buffer as ArrayBuffer);
      }
      parts.push(part);
      return part;
    };
    if (['usd', 'usda', 'usdc', 'usdz', 'urdf', 'sdf', 'mjcf'].includes(format)) {
      const loadAsset = (path: string): Promise<ArrayBuffer> => request('asset', { path });
      const loadMesh = async (
        bytes: ArrayBuffer,
        extension: string,
        path?: string,
      ): Promise<Object3D> => {
        if (extension === 'stl') return new Mesh(new STLLoader().parse(bytes));
        if (extension === 'obj') return new OBJLoader().parse(new TextDecoder().decode(bytes));
        if (extension === 'ply') return new Mesh(new PLYLoader().parse(bytes));
        if (['glb', 'gltf', 'dae'].includes(extension)) {
          const result = await request('mesh', { data: bytes, format: extension, path });
          return objectFromParts(result);
        }
        throw new Error(
          `Unsupported linked mesh format: ${extension}. Use STL, OBJ, PLY, DAE, or glTF.`,
        );
      };
      const parsed = format.startsWith('usd')
        ? await parseUsd(data, loadAsset, event.data.name)
        : await parseSimulation(data, format as 'urdf' | 'sdf' | 'mjcf', loadAsset, loadMesh).then(
            (model) => {
              joints = model.joints;
              return model;
            },
          );
      try {
        parts.push(...partsFromObject(parsed.object));
      } finally {
        disposeModel(parsed.object);
      }
    } else if (format === 'stl') add(new STLLoader().parse(data), 'Mesh');
    else if (format === 'step' || format === 'iges' || format === 'brep') {
      const cad = await initCad({ wasmBinary: event.data.wasm! });
      const bytes = new Uint8Array(data);
      const result =
        format === 'step'
          ? cad.ReadStepFile(bytes, null)
          : format === 'iges'
            ? cad.ReadIgesFile(bytes, null)
            : cad.ReadBrepFile(bytes, null);
      if (!result.success) throw new Error('Cannot tessellate CAD file.');
      let vertices = 0;
      for (const mesh of result.meshes) {
        vertices += mesh.attributes.position.array.length / 3;
        if (vertices > 6_000_000) throw new Error('CAD tessellation exceeds 6 million vertices.');
        const geometry = new BufferGeometry();
        geometry.setAttribute(
          'position',
          new Float32BufferAttribute(mesh.attributes.position.array, 3),
        );
        if (mesh.attributes.normal)
          geometry.setAttribute(
            'normal',
            new Float32BufferAttribute(mesh.attributes.normal.array, 3),
          );
        geometry.setIndex(mesh.index.array);
        const part = add(geometry, mesh.name || 'CAD part');
        part.surfaces = mesh.brep_faces?.map(({ first, last }) => ({ first, last }));
        const faces = mesh.brep_faces ?? [];
        const hasFaceColors = faces.some(({ color }) => color !== undefined);
        if (mesh.color || hasFaceColors) {
          const material = (color: [number, number, number]) => ({
            color,
            opacity: 1,
            metalness: 0.12,
            roughness: 0.48,
          });
          const neutral = new Color(0x94a8bb);
          part.materials = [material(mesh.color ?? [neutral.r, neutral.g, neutral.b])];
          if (hasFaceColors) {
            const groups: NonNullable<Part['groups']> = [];
            part.groups = groups;
            const indices = new Map([[part.materials[0].color.join(','), 0]]);
            let offset = 0;
            const group = (start: number, end: number, materialIndex: number) => {
              if (end <= start) return;
              const previous = groups.at(-1);
              if (previous?.materialIndex === materialIndex) previous.count += end - start;
              else groups.push({ start, count: end - start, materialIndex });
            };
            for (const { first, last, color } of faces) {
              if (!color) continue;
              const start = first * 3;
              const end = (last + 1) * 3;
              if (start < offset || end <= start || end > mesh.index.array.length) continue;
              const key = color.join(',');
              let materialIndex = indices.get(key);
              if (materialIndex === undefined) {
                materialIndex = part.materials.length;
                indices.set(key, materialIndex);
                part.materials.push(material(color));
              }
              group(offset, start, 0);
              group(start, end, materialIndex);
              offset = end;
            }
            group(offset, mesh.index.array.length, 0);
          }
        }
      }
    } else if (format === 'laz')
      add(await parseLaz(data, event.data.wasm!), 'LAZ point cloud', true);
    else if (format === 'las') add(parseLas(data), 'LAS point cloud', true);
    else if (format === 'vtu' || format === 'vtp') add(parseVtkXml(data), 'VTK mesh');
    else if (format === 'vtk') {
      if (!new TextDecoder().decode(data.slice(0, 512)).includes('DATASET POLYDATA'))
        throw new Error('Only legacy VTK POLYDATA surface meshes are supported.');
      const input =
        data.byteLength < 250
          ? (() => {
              const padded = new Uint8Array(250);
              padded.fill(32);
              padded.set(new Uint8Array(data));
              return padded.buffer;
            })()
          : data;
      add(new VTKLoader().parse(input, ''), 'VTK surface');
    } else if (format === 'pcd') {
      const cloud = parsePcd(data);
      add(cloud.geometry, 'Point cloud', true);
      cloud.material.dispose();
    } else if (format === 'ply') {
      const geometry = new PLYLoader().parse(data);
      add(geometry, geometry.index ? 'Mesh' : 'Point cloud', !geometry.index);
    } else if (format === 'obj') {
      const object = new OBJLoader().parse(new TextDecoder().decode(data));
      object.traverse((child: Object3D) => {
        if (child instanceof Mesh || child instanceof Points)
          add(child.geometry, child.name || 'Mesh', child instanceof Points);
      });
    } else throw new Error('Unsupported model parser.');
    if (!parts.length) throw new Error('No renderable geometry found.');
    if (!transfer.length)
      for (const part of parts) {
        for (const attribute of Object.values(part.attributes))
          transfer.push(attribute.array.buffer as ArrayBuffer);
        if (part.index) transfer.push(part.index.buffer as ArrayBuffer);
      }
    self.postMessage({ parts, joints }, { transfer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Malformed model.' });
  }
};
