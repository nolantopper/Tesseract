import type { ReadResourceResult } from '@modelcontextprotocol/server';

export const hostPreviewLimit = 64 * 1024 * 1024;

// The URI is opaque. Read only the response to the host-authorized request;
// hosts may return a canonical URI rather than echoing the requested URI.
export function hostResourceContent(resource: ReadResourceResult, uri: string) {
  const content =
    resource.contents.find((item) => item.uri === uri) ??
    (resource.contents.length === 1 ? resource.contents[0] : undefined);
  if (!content) throw new Error('The host did not return a unique opened-file resource.');
  return content;
}

export function hostResourceFile(resource: ReadResourceResult, uri: string, name: string): File {
  const content = hostResourceContent(resource, uri);
  let data: BlobPart;
  if ('blob' in content) {
    if (content.blob.length > 4 * Math.ceil(hostPreviewLimit / 3))
      throw new Error('Preview limit is 64 MiB.');
    let binary: string;
    try {
      binary = atob(content.blob);
    } catch {
      throw new Error('The host returned invalid base64 file bytes.');
    }
    data = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } else {
    // Never turn a lossy UTF-8 rendering of binary MCAP into a different file.
    if (/\.mcap$/i.test(name))
      throw new Error('The host returned text for a binary MCAP; base64 blob bytes are required.');
    data = content.text;
  }
  const file = new File([data], name, { type: content.mimeType });
  if (file.size > hostPreviewLimit) throw new Error('Preview limit is 64 MiB.');
  return file;
}
