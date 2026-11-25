import { plotMcap, sampleMcap, type McapRecordingRequest } from '../../shared/mcap-recording';
import { mcapSource } from './mcap-source';
import { renameMcapTopic } from '../../shared/mcap-edits';

self.onmessage = async ({
  data,
}: MessageEvent<{ size: number; port: MessagePort; request: McapRecordingRequest }>) => {
  try {
    const source = mcapSource(data.size, data.port);
    const request = data.request;
    if (request.kind === 'rename') {
      const result = await renameMcapTopic(source, request.channelId, request.topic);
      self.postMessage({ result }, { transfer: [result.buffer] });
    } else {
      const result = await (request.kind === 'plot'
        ? plotMcap(source, request.query)
        : sampleMcap(source, request.query));
      self.postMessage({ result });
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Cannot read recording.' });
  } finally {
    data.port.close();
  }
};
