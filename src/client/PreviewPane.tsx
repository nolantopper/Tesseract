import type { ComponentProps } from 'react';

export default function PreviewPane({
  title,
  className = '',
  children,
  ...props
}: ComponentProps<'section'> & { title: string }) {
  return (
    <section className={`preview-pane ${className}`} {...props}>
      <header className="preview-pane-title" title={title}>
        {title}
      </header>
      <div className="preview-pane-content">{children}</div>
    </section>
  );
}
