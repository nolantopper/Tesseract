type Span = { start: number; end: number };

// The caller parses the document first. The spans preserve numbers and unrelated source bytes.
export function replaceJsonProperty(
  source: string,
  path: (string | number)[],
  name: string,
  value: unknown,
) {
  const quoted = /"(?:[^"\\]|\\.)*"/sy;
  const skipSpace = (position: number) => {
    while (/\s/.test(source[position] ?? '')) position++;
    return position;
  };
  const endOfString = (start: number) => {
    quoted.lastIndex = start;
    if (!quoted.test(source)) throw new Error('Invalid JSON string.');
    return quoted.lastIndex;
  };
  const spanAt = (position: number): Span => {
    const start = skipSpace(position);
    const first = source[start];
    if (first === '"') return { start, end: endOfString(start) };
    let end = start;
    if (first === '[' || first === '{') {
      let depth = 1;
      end++;
      while (depth && end < source.length) {
        const character = source[end];
        if (character === '"') {
          end = endOfString(end);
          continue;
        }
        if (character === '[' || character === '{') depth++;
        if (character === ']' || character === '}') depth--;
        end++;
      }
    } else {
      while (end < source.length && !/[\s,\]}]/.test(source[end])) end++;
    }
    return { start, end };
  };
  const child = (parent: Span, key: string | number) => {
    const opening = source[parent.start];
    if (opening !== (typeof key === 'number' ? '[' : '{')) return;
    let position = skipSpace(parent.start + 1);
    let index = 0;
    let match: Span | undefined;
    while (position < parent.end - 1) {
      let current: string | number = index++;
      if (opening === '{') {
        const end = endOfString(position);
        current = JSON.parse(source.slice(position, end)) as string;
        position = skipSpace(end) + 1;
      }
      const childSpan = spanAt(position);
      if (current === key) match = childSpan;
      position = skipSpace(childSpan.end) + 1;
      position = skipSpace(position);
    }
    return match;
  };
  let parent: Span | undefined = spanAt(0);
  for (const key of path) {
    if (!parent) break;
    parent = child(parent, key);
  }
  if (!parent || source[parent.start] !== '{') throw new Error('JSON object no longer exists.');
  const current = child(parent, name);
  const encoded = JSON.stringify(value);
  if (current) return source.slice(0, current.start) + encoded + source.slice(current.end);
  const afterOpen = parent.start + 1;
  const comma = skipSpace(afterOpen) === parent.end - 1 ? '' : ',';
  return (
    source.slice(0, afterOpen) +
    JSON.stringify(name) +
    ': ' +
    encoded +
    comma +
    source.slice(afterOpen)
  );
}
