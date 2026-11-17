import {
  BufferGeometry,
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

export interface Part {
  name: string;
  points: boolean;
  attributes: Record<string, { array: Float32Array; itemSize: number }>;
  index?: Uint16Array | Uint32Array;
}
self.onmessage = async (
  event: MessageEvent<{ format: string; data: ArrayBuffer; wasm?: ArrayBuffer }>,
) => {
  try {
    const { format, data } = event.data;
    const parts: Part[] = [];
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
    };
    if (format === 'stl') add(new STLLoader().parse(data), 'Mesh');
    else if (format === 'step' || format === 'iges') {
      const cad = await initCad({ wasmBinary: event.data.wasm! });
      const result =
        format === 'step'
          ? cad.ReadStepFile(new Uint8Array(data), null)
          : cad.ReadIgesFile(new Uint8Array(data), null);
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
        add(geometry, mesh.name || 'CAD part');
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
    self.postMessage({ parts }, { transfer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Malformed model.' });
  }
};
