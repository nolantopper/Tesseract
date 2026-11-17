import { mkdir, writeFile } from 'node:fs/promises';
import { BoxGeometry, Group, Mesh, TorusGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { McapWriter } from '@mcap/core';
import { resolve } from 'node:path';

export async function makeSamples(dir: string) {
  await mkdir(dir, { recursive: true });
  const ring = new TorusGeometry(1.5, 0.35, 24, 64);
  const base = new BoxGeometry(4.2, 0.6, 1.8);
  base.translate(0, -1.9, 0);
  const left = new BoxGeometry(0.65, 1.8, 1.3);
  left.translate(-1.5, -0.9, 0);
  const right = left.clone();
  right.translate(3, 0, 0);
  const geometry = mergeGeometries([ring, base, left, right]);
  const group = new Group();
  const mesh = new Mesh(geometry);
  mesh.name = 'Bearing bracket';
  group.add(mesh);
  const stl = new STLExporter().parse(group, { binary: true });
  await writeFile(resolve(dir, 'bracket.stl'), new Uint8Array(stl.buffer));
  await writeFile(resolve(dir, 'bracket.obj'), new OBJExporter().parse(group));
  const flat = geometry.toNonIndexed();
  const positions = new Float32Array(flat.getAttribute('position').array);
  const normals = new Float32Array(flat.getAttribute('normal').array);
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer)]);
  flat.computeBoundingBox();
  const gltf = {
    asset: { version: '2.0', generator: 'Tesseract samples' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Bearing bracket', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.52, 0.65, 0.75, 1],
          metallicFactor: 0.3,
          roughnessFactor: 0.4,
        },
      },
    ],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: flat.boundingBox!.min.toArray(),
        max: flat.boundingBox!.max.toArray(),
      },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    ],
  };
  const jsonText = JSON.stringify(gltf);
  const json = Buffer.from(jsonText.padEnd(Math.ceil(Buffer.byteLength(jsonText) / 4) * 4, ' '));
  const header = Buffer.alloc(12);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length);
  binHeader.writeUInt32LE(0x004e4942, 4);
  await writeFile(
    resolve(dir, 'bracket.glb'),
    Buffer.concat([header, jsonHeader, json, binHeader, binary]),
  );
  await writeFile(
    resolve(dir, 'pyramid.ply'),
    'ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\nelement face 6\nproperty list uchar int vertex_indices\nend_header\n-1 0 -1\n1 0 -1\n1 0 1\n-1 0 1\n0 2 0\n3 0 1 4\n3 1 2 4\n3 2 3 4\n3 3 0 4\n3 0 3 2\n3 0 2 1\n',
  );
  const cloud = [
    '# .PCD v0.7',
    'VERSION 0.7',
    'FIELDS x y z rgb',
    'SIZE 4 4 4 4',
    'TYPE F F F U',
    'COUNT 1 1 1 1',
    'WIDTH 441',
    'HEIGHT 1',
    'POINTS 441',
    'DATA ascii',
  ];
  for (let x = -10; x <= 10; x++)
    for (let z = -10; z <= 10; z++)
      cloud.push(`${x / 10} ${(x * x + z * z) / 100} ${z / 10} ${0x33bbff}`);
  await writeFile(resolve(dir, 'scan.pcd'), cloud.join('\n') + '\n');
  await writeFile(
    resolve(dir, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  await writeFile(
    resolve(dir, 'diagram.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#192530"/><g fill="none" stroke="#9abbd4" stroke-width="2"><circle cx="400" cy="220" r="115"/><circle cx="400" cy="220" r="65"/><path d="M240 340h320v45H240z M280 340v-85 M520 340v-85"/><path stroke-dasharray="8 8" stroke-width="1" d="M400 60v350 M220 220h360"/></g><text x="400" y="455" text-anchor="middle" font-family="monospace" font-size="16" fill="#9abbd4">BEARING BRACKET · FRONT VIEW</text></svg>',
  );
  await writeFile(
    resolve(dir, 'telemetry.json'),
    JSON.stringify({ frame: 'base_link', position: [0.2, 1.1, 0.4], units: 'm' }, null, 2),
  );
  await writeFile(resolve(dir, 'unsupported.step'), 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
  await writeFile(resolve(dir, 'invalid.stl'), 'This is not a valid STL.');
  await writeFile(
    resolve(dir, 'invalid.mcap'),
    Buffer.from([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a, 0, 1]),
  );
  const chunks: Uint8Array[] = [];
  let offset = 0n;
  const writer = new McapWriter({
    writable: {
      position: () => offset,
      write: async (data) => {
        chunks.push(data.slice());
        offset += BigInt(data.length);
      },
    },
  });
  await writer.start({ profile: 'robotics-demo', library: 'tesseract' });
  const schema = await writer.registerSchema({
    name: 'Telemetry',
    encoding: 'jsonschema',
    data: new TextEncoder().encode('{"type":"object"}'),
  });
  const channels: number[] = [];
  for (const topic of ['/joint_states', '/telemetry/temperature', '/camera/info'])
    channels.push(
      await writer.registerChannel({
        topic,
        schemaId: schema,
        messageEncoding: 'json',
        metadata: new Map(),
      }),
    );
  const start = 1730000000000000000n;
  for (let i = 0; i < 60; i++) {
    const time = start + BigInt(i) * 100000000n;
    await writer.addMessage({
      channelId: channels[i % 3],
      sequence: i,
      logTime: time,
      publishTime: time,
      data: new TextEncoder().encode(JSON.stringify({ value: Math.sin(i / 10), frame: i })),
    });
  }
  await writer.addMetadata({
    name: 'recording',
    metadata: new Map([
      ['robot', 'demo-arm'],
      ['session', 'inspection-001'],
    ]),
  });
  await writer.end();
  await writeFile(resolve(dir, 'robot.mcap'), Buffer.concat(chunks));
  group.traverse((o) => {
    if (o instanceof Mesh) o.geometry.dispose();
  });
}
if (process.argv[1]?.endsWith('samples.ts')) {
  await makeSamples(resolve('samples'));
  console.log('Sample artifacts written to samples/');
}
