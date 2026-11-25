import { useEffect, useRef, useState, type ReactNode } from 'react';
import PreviewPane from '../PreviewPane';

export default function McapVisiblePane({
  title,
  children,
}: {
  title: string;
  children: (visible: boolean) => ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = pane.current!;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: node.closest('.mcap-view'),
      rootMargin: '100px 0px',
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={pane} className="mcap-visible-pane">
      {children(visible) ?? <PreviewPane title={title} />}
    </div>
  );
}
