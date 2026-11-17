import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePcd } from '../src/client/viewers/pcd.js';
import { detectFormat } from '../src/shared/formats.js';

const header = (mode: string, points = 3) =>
  `# .PCD v0.7\nVERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH ${points}\nHEIGHT 1\nPOINTS ${points}\nDATA ${mode}\n`;
const buffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
test('PCD ASCII, binary, and LZF compressed preserve coordinates and RGB', () => {
  const rows = [
    [0, 0, 0, 0xff0000],
    [1, 0, 0, 0x00ff00],
    [0, 1, 0, 0x0000ff],
  ];
  const binary = Buffer.alloc(48),
    columns = Buffer.alloc(48);
  rows.forEach((row, i) =>
    row.forEach((n, j) => {
      if (j === 3) {
        binary.writeUInt32LE(n, i * 16 + j * 4);
        columns.writeUInt32LE(n, j * 12 + i * 4);
      } else {
        binary.writeFloatLE(n, i * 16 + j * 4);
        columns.writeFloatLE(n, j * 12 + i * 4);
      }
    }),
  );
  // LZF literal blocks (no back references), in field-major layout.
  const compressed = Buffer.concat([
    Buffer.from([31]),
    columns.subarray(0, 32),
    Buffer.from([15]),
    columns.subarray(32),
  ]);
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(compressed.length);
  sizes.writeUInt32LE(columns.length, 4);
  for (const [mode, payload] of [
    ['ascii', Buffer.from(rows.map((r) => r.join(' ')).join('\n') + '\n')],
    ['binary', binary],
    ['binary_compressed', Buffer.concat([sizes, compressed])],
  ] as const) {
    const cloud = parsePcd(buffer(Buffer.concat([Buffer.from(header(mode)), payload])));
    assert.deepEqual(
      Array.from(cloud.geometry.getAttribute('position').array),
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
    );
    assert.deepEqual(
      Array.from(cloud.geometry.getAttribute('color').array),
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
    );
    cloud.geometry.dispose();
    cloud.material.dispose();
  }
  assert.equal(detectFormat('scan.PCD', new Uint8Array()).id, 'pcd');
});
test('PCD rejects malformed headers, allocation bombs, truncated payloads and non-finite points', () => {
  for (const value of [
    'garbage',
    header('ascii', 6_000_001),
    header('binary'),
    header('binary_compressed'),
    header('ascii') + 'NaN 0 0 0\n0 0 0 0\n0 0 0 0\n',
    header('ascii', 6_000_000),
  ]) {
    assert.throws(() => parsePcd(buffer(Buffer.from(value))), /PCD/);
  }
  const sizes = Buffer.alloc(8);
  sizes.writeUInt32LE(0);
  sizes.writeUInt32LE(0xffffffff, 4);
  assert.throws(
    () => parsePcd(buffer(Buffer.concat([Buffer.from(header('binary_compressed')), sizes]))),
    /declared size/,
  );
});
