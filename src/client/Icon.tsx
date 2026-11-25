import type { ReactNode } from 'react';

const paths = {
  file: (
    <>
      <path d="M9 3H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V10Z" />
      <path d="M9 3v7h7" />
    </>
  ),
  folder: (
    <path d="M2.5 6a1 1 0 0 1 1-1H8l2 2h6.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z" />
  ),
  search: (
    <>
      <circle cx="8.5" cy="8.5" r="4.5" />
      <path d="m12 12 4.5 4.5" />
    </>
  ),
  check: <path d="m4.5 10 3.5 3.5 7.5-7.5" />,
  edit: (
    <path d="m11.7 4.6 3.7 3.7M3.5 16.5l.9-4 9.3-9.3a1.4 1.4 0 0 1 2 0l1.1 1.1a1.4 1.4 0 0 1 0 2l-9.3 9.3-4 .9Z" />
  ),
  download: <path d="M10 3v9m-3.5-3.5L10 12l3.5-3.5M4 12.5V16h12v-3.5" />,
  expand: <path d="M7 3H3v4m10-4h4v4m0 6v4h-4m-6 0H3v-4" />,
  collapse: <path d="M3 7h4V3m6 0v4h4m0 6h-4v4m-6 0v-4H3" />,
  close: <path d="m5 5 10 10M15 5 5 15" />,
  play: <path d="m7 4 9 6-9 6Z" />,
  pause: <path d="M7 4v12m6-12v12" />,
  chevron: <path d="m8 5 5 5-5 5" />,
  minus: <path d="M4 10h12" />,
  plus: <path d="M4 10h12m-6-6v12" />,
  fit: (
    <>
      <rect x="5" y="5" width="10" height="10" rx="1" />
      <path d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
