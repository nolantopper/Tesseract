import { z } from 'zod';

const timestamp = z.string().regex(/^\d{1,30}$/);
const channel = z.number().int().min(0).max(65535);
const timeRange = z.object({ startNs: timestamp, endNs: timestamp });
const objectId = z.string().min(1).max(200);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const maxModelParts = 200;
export const maxModelJoints = 128;
const xyz = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const selectedFace = z.object({
  kind: z.enum(['surface', 'planar', 'triangle']),
  index: z.number().int().nonnegative(),
  triangleCount: z.number().int().positive(),
  normal: xyz,
  localNormal: xyz.optional(),
});
export const selectedPart = z.object({
  objectId,
  objectName: z.string().max(200),
  coordinates: xyz,
  localCoordinates: xyz.optional(),
  face: selectedFace.optional(),
});
export type SelectedPart = z.infer<typeof selectedPart>;
export const selectionKey = ({
  objectId,
  face,
}: {
  objectId: string;
  face?: Pick<NonNullable<SelectedPart['face']>, 'kind' | 'index'>;
}) => (face ? `${objectId}/${face.kind}/${face.index}` : objectId);
const modelJoint = z.object({
  id: objectId,
  name: z.string().max(200),
  unit: z.enum(['rad', 'm']),
  min: z.number().finite(),
  max: z.number().finite(),
  value: z.number().finite(),
});
export type ModelJoint = z.infer<typeof modelJoint>;
export const sharedItem = z.object({
  id: objectId,
  label: z.string().min(1).max(300),
  details: z.string().max(4096).optional(),
});
export type SharedItem = z.infer<typeof sharedItem>;

const mcapColumns = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional();
const mcapPane = z
  .object({
    channelId: channel,
    field: z.string().min(1).max(120).optional(),
    fullWidth: z.boolean().optional().describe('Span the entire row in the recording preview.'),
  })
  .strict();
export const mcapLayout = z.union([
  z
    .object({
      panes: z.array(mcapPane).max(16),
      columns: mcapColumns,
    })
    .strict(),
  z.object({ allTopics: z.literal(true), columns: mcapColumns }).strict(),
]);
export type McapPane = z.infer<typeof mcapPane>;
export type McapLayout = z.infer<typeof mcapLayout>;

export const viewerContext = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    objects: z
      .array(
        z.object({
          id: objectId,
          name: z.string().max(200),
          color: color.optional(),
          textured: z.boolean().optional(),
          editableSurfaces: z.number().int().positive().optional(),
        }),
      )
      .max(maxModelParts),
    joints: z.array(modelJoint).max(maxModelJoints).optional(),
    canRotate: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal('mcap'),
    timestampNs: timestamp.optional(),
    topicChannelId: channel.optional(),
    cameraChannelId: channel.optional(),
    range: timeRange.optional(),
    channelIds: z.array(channel).max(200).optional(),
    cameraChannelIds: z.array(channel).max(200).optional(),
    plotChannelIds: z.array(channel).max(200).optional(),
    layout: mcapLayout.optional(),
    playing: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('container'),
    entry: z.string().max(4096).optional(),
    entryFormat: z.string().max(80).optional(),
    textPreview: z.string().max(4096).optional(),
  }),
]);

const setColor = z.object({ kind: z.literal('set_color'), objectId, color }).strict();
const setFaceColor = z
  .object({
    kind: z.literal('set_face_color'),
    objectId,
    faceIndex: z.number().int().nonnegative(),
    color,
  })
  .strict();
const rotateModel = z
  .object({ kind: z.literal('rotate_model'), axis: z.enum(['x', 'y', 'z']) })
  .strict();
export const modelEditAction = z.discriminatedUnion('kind', [setColor, setFaceColor, rotateModel]);
export const previewViewAction = z.discriminatedUnion('kind', [
  setColor,
  z
    .object({ kind: z.literal('set_joint'), jointId: objectId, value: z.number().finite() })
    .strict(),
  z
    .object({
      kind: z.literal('mcap_view'),
      timestampNs: timestamp.optional(),
      cameraChannelId: channel.optional(),
      range: timeRange.nullable().optional(),
      channelIds: z.array(channel).max(200).optional(),
      layout: mcapLayout.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcap_sample'),
      channelId: channel,
      startNs: timestamp.optional(),
      endNs: timestamp.optional(),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('capture') }).strict(),
  z.object({ kind: z.literal('undo') }).strict(),
]);
const viewAction = z.discriminatedUnion('kind', [
  ...previewViewAction.options,
  setFaceColor,
  rotateModel,
]);
export const viewCommand = z.object({
  id: z.string().uuid(),
  action: viewAction,
  save: z.literal(true).optional(),
});
const viewSample = z.object({
  timestampNs: timestamp,
  channelId: channel,
  value: z.string().max(2000),
});
export const viewResult = z.object({
  id: z.string().uuid(),
  message: z.string().max(300),
  error: z.boolean().optional(),
  samples: z.array(viewSample).max(20).optional(),
});
export const viewIdentity = z.object({
  viewId: z.string().uuid(),
  revision: z.string().min(1).max(200),
});
export const viewSnapshot = z.object({
  name: z.string().min(1).max(512),
  format: z.string().min(1).max(80),
  size: z.number().int().nonnegative(),
  context: viewerContext.nullable(),
  selected: z
    .object({
      objectId: objectId.optional(),
      objectName: z.string().max(200).optional(),
      face: selectedFace.optional(),
      coordinates: z
        .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
        .optional(),
      parts: z.array(selectedPart).min(1).max(maxModelParts).optional(),
      timestampNs: timestamp.optional(),
      channelId: channel.optional(),
      item: sharedItem.optional(),
    })
    .optional(),
  recording: z
    .object({
      startNs: timestamp,
      endNs: timestamp,
      topics: z
        .array(z.object({ id: channel, name: z.string().max(300), schema: z.string().max(300) }))
        .max(200),
    })
    .optional(),
});
export const viewImage = z
  .string()
  .max(275000)
  .regex(/^\/9j\/[a-zA-Z0-9+/]+={0,2}$/);

export type ViewerContext = z.infer<typeof viewerContext>;
export type ViewAction = z.infer<typeof viewAction>;
export type ViewCommand = z.infer<typeof viewCommand>;
export type ViewResult = z.infer<typeof viewResult>;
export type ViewSample = z.infer<typeof viewSample>;
export type ViewIdentity = z.infer<typeof viewIdentity>;
export type ViewSnapshot = z.infer<typeof viewSnapshot>;

export function validateViewAction(context: ViewerContext | null, action: ViewAction) {
  switch (action.kind) {
    case 'rotate_model':
      if (context?.kind !== 'model' || !context.canRotate)
        throw new Error('This model cannot be rotated in place.');
      return;
    case 'set_color':
      if (
        context?.kind !== 'model' ||
        !context.objects.some((object) => object.id === action.objectId && object.color)
      )
        throw new Error('That part cannot be recolored in this preview.');
      return;
    case 'set_face_color': {
      const mesh =
        context?.kind === 'model' && context.objects.find(({ id }) => id === action.objectId);
      if (!mesh || action.faceIndex >= (mesh.editableSurfaces ?? 0))
        throw new Error('That face cannot be recolored in this preview.');
      return;
    }
    case 'set_joint': {
      const joint =
        context?.kind === 'model' && context.joints?.find(({ id }) => id === action.jointId);
      if (!joint) throw new Error('That joint is unavailable in this preview.');
      if (action.value < joint.min || action.value > joint.max)
        throw new Error(`Joint value must be between ${joint.min} and ${joint.max} ${joint.unit}.`);
      return;
    }
    case 'mcap_view':
      if (context?.kind !== 'mcap') throw new Error('This preview is not an MCAP recording.');
      if (
        action.cameraChannelId !== undefined &&
        !context.cameraChannelIds?.includes(action.cameraChannelId)
      )
        throw new Error('That camera is unavailable in this preview.');
      if (
        action.timestampNs === undefined &&
        action.cameraChannelId === undefined &&
        action.range === undefined &&
        action.channelIds === undefined &&
        action.layout === undefined
      )
        throw new Error('Choose a layout, camera, time, range, or topic filter.');
      return;
    case 'mcap_sample':
      if (context?.kind !== 'mcap') throw new Error('This preview is not an MCAP recording.');
      return;
    case 'capture':
      if (context?.kind !== 'model' && context?.kind !== 'mcap')
        throw new Error('This preview does not support image capture.');
      return;
    case 'undo':
      if (context?.kind !== 'mcap') throw new Error('Only recording view changes support undo.');
  }
}
