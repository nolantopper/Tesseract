import type { CadResult } from 'occt-import-js';
import { Color, SRGBColorSpace } from 'three';

export type StepFacePaint = { mesh: number; face: number; color: string };
type ReadStep = (bytes: Uint8Array, options: null) => CadResult;
type RGB = [number, number, number];

const same = (a: number[] | undefined, b: number[] | undefined) =>
  a?.length === b?.length && (!a || a.every((value, index) => value === b![index]));

function sameGeometry(before: CadResult, after: CadResult) {
  return (
    after.success &&
    after.meshes.length === before.meshes.length &&
    before.meshes.every((a, index) => {
      const b = after.meshes[index];
      return (
        a.name === b.name &&
        same(a.color, b.color) &&
        same(a.attributes.position.array, b.attributes.position.array) &&
        same(a.attributes.normal?.array, b.attributes.normal?.array) &&
        same(a.index.array, b.index.array) &&
        a.brep_faces?.length === b.brep_faces?.length &&
        (!a.brep_faces ||
          a.brep_faces.every(
            (face, i) =>
              face.first === b.brep_faces![i].first && face.last === b.brep_faces![i].last,
          ))
      );
    })
  );
}

function nearColor(color: number[] | undefined, expected: Color) {
  return (
    !!color &&
    [expected.r, expected.g, expected.b].every(
      (component, index) => Math.abs(color[index] - component) < 1e-6,
    )
  );
}

export function repaintStepFace(
  source: Uint8Array,
  edit: StepFacePaint,
  read: ReadStep,
): ArrayBuffer {
  if (source.length > 8 * 1024 * 1024)
    throw new Error('STEP face edits support files up to 8 MiB.');
  if (!/^#[0-9a-f]{6}$/i.test(edit.color)) throw new Error('Invalid STEP face color.');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
  const structure = text.replace(/'(?:''|[^'])*'|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("'") ? "''" : ' ',
  );
  const end = /ENDSEC;\s*END-ISO-10303-21;\s*$/i.exec(text)?.index;
  if (end === undefined || (structure.match(/\bDATA\s*;/gi)?.length ?? 0) !== 1)
    throw new Error('This STEP file does not use a single editable data section.');
  const faces: number[] = [];
  const contexts = new Set<number>();
  const representationContexts = new Set<number>();
  let lastId = 0;
  for (const [, id, entity] of structure.matchAll(/#(\d+)\s*=\s*([^;]+);/g)) {
    lastId = Math.max(lastId, Number(id));
    if (/^ADVANCED_FACE\s*\(/i.test(entity)) faces.push(Number(id));
    if (/^\(\s*GEOMETRIC_REPRESENTATION_CONTEXT\s*\(\s*3\s*\)/i.test(entity))
      contexts.add(Number(id));
    const context = /^(?:[A-Z_]*SHAPE_REPRESENTATION)\s*\([\s\S]*,\s*#(\d+)\s*\)\s*$/i.exec(
      entity,
    )?.[1];
    if (context) representationContexts.add(Number(context));
  }
  if (!faces.length || faces.length > 2048 || !Number.isSafeInteger(lastId + 20000))
    throw new Error('STEP face edits support up to 2,048 authored surfaces.');
  const candidates = [...new Set([...representationContexts, ...contexts])]
    .filter((id) => contexts.has(id))
    .slice(0, 8);
  const original = read(source, null);
  const target = original.meshes[edit.mesh]?.brep_faces?.[edit.face];
  if (!original.success || !target) throw new Error('The selected STEP face is unavailable.');
  const requested = new Color(edit.color);
  if (nearColor(target.color, requested)) return new Uint8Array(source).buffer;

  const styled = (context: number, edits: [number, RGB][]) => {
    const records: string[] = [];
    const add = (record: string) => {
      const reference = `#${lastId + records.length + 1}`;
      records.push(`${reference}=${record};`);
      return reference;
    };
    const items = edits.map(([face, rgb]) => {
      const color = add(`COLOUR_RGB('',${rgb.map((c) => c.toFixed(8)).join(',')})`);
      const fillColor = add(`FILL_AREA_STYLE_COLOUR('',${color})`);
      const fill = add(`FILL_AREA_STYLE('',(${fillColor}))`);
      const surface = add(`SURFACE_STYLE_FILL_AREA(${fill})`);
      const side = add(`SURFACE_SIDE_STYLE('',(${surface}))`);
      const usage = add(`SURFACE_STYLE_USAGE(.BOTH.,${side})`);
      const assignment = add(`PRESENTATION_STYLE_ASSIGNMENT((${usage}))`);
      return add(`STYLED_ITEM('',(${assignment}),#${face})`);
    });
    add(
      `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${items.join(',')}),#${context})`,
    );
    const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
    return new TextEncoder().encode(
      text.slice(0, end) + records.join(lineEnding) + lineEnding + text.slice(end),
    );
  };
  const srgb: RGB = [1, 3, 5].map(
    (offset) => Number.parseInt(edit.color.slice(offset, offset + 2), 16) / 255,
  ) as RGB;
  const verifiesEdit = (output: Uint8Array) => {
    const verified = read(output, null);
    return (
      sameGeometry(original, verified) &&
      original.meshes.every((mesh, meshIndex) =>
        (mesh.brep_faces ?? []).every(({ color }, faceIndex) => {
          const next = verified.meshes[meshIndex].brep_faces![faceIndex].color;
          return meshIndex === edit.mesh && faceIndex === edit.face
            ? nearColor(next, requested)
            : same(color, next);
        }),
      )
    );
  };
  // Single solids often follow their authored order. Verify it before building a probe.
  if (
    original.meshes.length === 1 &&
    faces.length === original.meshes[0].brep_faces?.length &&
    candidates.length
  ) {
    const output = styled(candidates[0], [[faces[edit.face], srgb]]);
    if (verifiesEdit(output)) return output.buffer;
  }
  // The CAD decoder can reorder faces. Probe presentation references and verify the final edit
  // by decoding again, refusing shared or ambiguous faces that would change another surface.
  const probe: [number, RGB][] = faces.map((face, index) => [
    face,
    [0.237, (1 + (index % 127)) / 128, (1 + Math.floor(index / 127)) / 32],
  ]);
  const probeColors = probe.map(([, rgb]) => new Color().setRGB(...rgb, SRGBColorSpace));
  for (const context of candidates) {
    const tagged = read(styled(context, probe), null);
    if (!sameGeometry(original, tagged)) continue;
    const taggedFace = tagged.meshes[edit.mesh].brep_faces![edit.face];
    if (same(target.color, taggedFace.color)) continue;
    const index = probeColors.findIndex((color) => nearColor(taggedFace.color, color));
    if (index < 0) continue;
    const output = styled(context, [[faces[index], srgb]]);
    if (verifiesEdit(output)) return output.buffer;
  }
  throw new Error('The selected STEP face could not be mapped to a single editable surface.');
}
