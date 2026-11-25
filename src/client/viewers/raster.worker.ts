import { type RasterRequest, type RasterResponse, type RasterSource } from './raster';
import { openHdr, openPsd, openTiff } from './raster-images';
import { openDicom, openNifti, openNrrd } from './volume-data';

let source: RasterSource | undefined;
let render = Promise.resolve();
let latest = 0;
const post = (message: RasterResponse, transfer?: Transferable[]) => {
  self.postMessage(message, { transfer });
};

self.onmessage = ({ data }: MessageEvent<RasterRequest>) => {
  if ('choice' in data) latest = data.sequence;
  // Only decode the newest selection after an in-flight decode finishes.
  render = render.then(async () => {
    try {
      if ('choice' in data) {
        const { choice, sequence } = data;
        if (sequence !== latest) return;
        const group = source?.groups[choice.group];
        if (
          !group ||
          !Number.isInteger(choice.index) ||
          choice.index < 0 ||
          choice.index >= group.count
        )
          throw new Error('Invalid image selection.');
        const frame = await source!.render(choice);
        if (sequence === latest) post({ frame, choice, sequence }, [frame.data.buffer]);
      } else {
        switch (data.format) {
          case 'tiff':
            source = await openTiff(data.data);
            break;
          case 'psd':
            source = openPsd(data.data);
            break;
          case 'exr':
            source = openHdr(data.data, true);
            break;
          case 'hdr':
            source = openHdr(data.data, false);
            break;
          case 'dicom':
            source = openDicom(data.data);
            break;
          case 'nifti':
            source = openNifti(data.data);
            break;
          case 'nrrd':
            source = openNrrd(data.data, data.detached);
            break;
          default:
            throw new Error('Unsupported image format.');
        }
        post({ groups: source.groups });
      }
    } catch (error) {
      post({
        error: error instanceof Error ? error.message : 'Couldn’t decode image.',
        sequence: 'sequence' in data ? data.sequence : undefined,
      });
    }
  });
};
