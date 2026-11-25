import type { McapInfo } from '../../shared/types';
import type { ViewAction, ViewerContext } from '../../shared/view';
import { isCamera, layoutPanes, validateMcapLayout } from '../../shared/mcap-layout';

export type McapView = Pick<
  Extract<ViewerContext, { kind: 'mcap' }>,
  'timestampNs' | 'topicChannelId' | 'cameraChannelId' | 'range' | 'channelIds' | 'layout'
> & { timestampNs: string };

export function updateMcapView(
  current: McapView,
  action: Extract<ViewAction, { kind: 'mcap_view' }>,
  info: McapInfo,
): McapView {
  const { timestampNs, cameraChannelId, channelIds, range, layout } = action;
  const next = { ...current };
  if (cameraChannelId !== undefined) {
    if (layout) throw new Error('Choose either a camera or a pane layout.');
    if (!info.topics.some((topic) => topic.id === cameraChannelId && isCamera(topic)))
      throw new Error('Camera channel is unavailable.');
    next.cameraChannelId = cameraChannelId;
    next.topicChannelId = cameraChannelId;
    next.layout = undefined;
  }
  if (layout) {
    validateMcapLayout(layout, info);
    next.layout = layout;
    if ('allTopics' in layout) next.channelIds = undefined;
    const first = info.topics.find(({ id }) => id === layoutPanes(layout, info)[0]?.channelId);
    next.topicChannelId = first?.id;
    next.cameraChannelId = first && isCamera(first) ? first.id : undefined;
  }
  if (channelIds !== undefined) {
    if (channelIds.length > 200) throw new Error('Select up to 200 topics.');
    if (channelIds.some((id) => !info.topics.some((topic) => topic.id === id)))
      throw new Error('Topic channel is unavailable.');
    next.channelIds = channelIds.length ? [...new Set(channelIds)] : undefined;
  }
  if (
    next.topicChannelId !== undefined &&
    next.channelIds &&
    !next.channelIds.includes(next.topicChannelId)
  ) {
    next.topicChannelId = undefined;
    next.cameraChannelId = undefined;
  }
  if (range !== undefined) next.range = range ?? undefined;
  const lower = BigInt(next.range?.startNs ?? info.startTime);
  const upper = BigInt(next.range?.endNs ?? info.endTime);
  if (
    lower < BigInt(info.startTime) ||
    upper > BigInt(info.endTime) ||
    lower > upper ||
    (next.range && lower === upper)
  )
    throw new Error('Playback range must be inside the recording and have a start before its end.');
  const position = BigInt(timestampNs ?? next.timestampNs);
  if (timestampNs !== undefined && (position < lower || position > upper))
    throw new Error('Timestamp is outside the playback range.');
  next.timestampNs = String(position < lower ? lower : position > upper ? upper : position);
  return next;
}
