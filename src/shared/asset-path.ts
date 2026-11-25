function decodedPath(value: string) {
  let path: string;
  try {
    path = decodeURIComponent(value).replaceAll('\\', '/');
  } catch {
    throw new Error('Invalid asset path.');
  }
  if (!path || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error('Invalid asset path.');
  return path;
}

export function resolveAssetPath(source: string, reference: string) {
  return resolveDecodedPath(source, decodedPath(reference));
}

export function joinAssetReference(source: string, reference: string): string {
  const path = decodedPath(reference);
  if (path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path))
    throw new Error('Assets must use relative paths inside the opened folder or archive.');
  const normalizedSource = source.replaceAll('\\', '/');
  const sourcePath = source ? decodedPath(source) : '';
  if (/^(?:package|model):\/\//i.test(sourcePath)) {
    resolveAssetPath(normalizedSource, reference);
  } else if (sourcePath.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(sourcePath)) {
    throw new Error('Assets must use relative paths inside the opened folder or archive.');
  }
  // Preserve the document-relative frame and URI escapes for the final scoped resolver.
  return (
    normalizedSource.slice(0, normalizedSource.lastIndexOf('/') + 1) +
    reference.replaceAll('\\', '/')
  );
}

function resolveDecodedPath(source: string, path: string): string {
  if (path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path))
    throw new Error('Assets must use relative paths inside the opened folder or archive.');
  const normalizedSource = source.replaceAll('\\', '/');
  const packageBase = /^((?:package|model):\/\/[^/]+\/)(.*)$/i.exec(normalizedSource);
  if (packageBase) return packageBase[1] + resolveDecodedPath(packageBase[2], path);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(normalizedSource))
    throw new Error('Assets must use relative paths inside the opened folder or archive.');
  const absolute = normalizedSource.startsWith('/');
  const segments = normalizedSource.split('/').slice(0, -1).filter(Boolean);
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length || /^[a-z]:$/i.test(segments.at(-1)!))
        throw new Error('Asset path leaves the opened folder or archive.');
      segments.pop();
    } else segments.push(segment);
  }
  if (!segments.length) throw new Error('Asset path must identify a file.');
  return `${absolute ? '/' : ''}${segments.join('/')}`;
}

export function packageAssetPaths(reference: string): string[] | undefined {
  const path = decodedPath(reference);
  const match = /^(?:package|model):\/\/([^/]+)\/(.+)$/i.exec(path);
  if (!match) return;
  const [, name, relative] = match;
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..')
    throw new Error('Invalid asset package name.');
  // Package paths are rooted in the selected package, never the referring file's directory.
  const normalized = resolveDecodedPath('', relative);
  return [`${name}/${normalized}`, normalized];
}
