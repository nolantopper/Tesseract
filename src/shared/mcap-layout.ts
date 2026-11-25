import { supportsPlot } from './mcap-recording.js';
import type { McapInfo, Topic } from './types.js';
import type { McapLayout, McapPane } from './view.js';

export function isCamera(topic: Topic) {
  return topic.schema === 'foxglove.CompressedVideo' && topic.encoding === 'protobuf';
}

export function isPlot(info: McapInfo, topic: Topic) {
  return info.indexed && supportsPlot(topic.encoding, topic.schema);
}

export function layoutPanes(layout: McapLayout, info: McapInfo): McapPane[] {
  return 'panes' in layout ? layout.panes : info.topics.map(({ id }) => ({ channelId: id }));
}

export function validateMcapLayout(layout: McapLayout, info: McapInfo) {
  if (!('panes' in layout)) return;
  const seen = new Set<string>();
  for (const pane of layout.panes) {
    const topic = info.topics.find(({ id }) => id === pane.channelId);
    if (!topic || (pane.field !== undefined && !isPlot(info, topic)))
      throw new Error(`Topic ${pane.channelId} cannot display this preview.`);
    const key = JSON.stringify([pane.channelId, pane.field]);
    if (seen.has(key)) throw new Error('Each pane needs a distinct topic or graph field.');
    seen.add(key);
  }
}
