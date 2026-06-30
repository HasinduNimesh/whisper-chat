/**
 * Small inline-SVG icon set (zero dependencies). Each icon inherits the current
 * text color and accepts a className for sizing, e.g. <Mic className="h-5 w-5" />.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const Shield = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
    <path d="M9.5 12l1.8 1.8L15 10" />
  </Base>
);

export const Lock = (p: IconProps) => (
  <Base {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Base>
);

export const Send = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 12l16-7-7 16-2.5-6.5L4 12z" />
  </Base>
);

export const Mic = (p: IconProps) => (
  <Base {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Base>
);

export const MicOff = (p: IconProps) => (
  <Base {...p}>
    <path d="M15 9V6a3 3 0 0 0-5.6-1.5M9 9v2a3 3 0 0 0 4.5 2.6" />
    <path d="M5 11a7 7 0 0 0 10.5 6M19 11a6.9 6.9 0 0 1-.5 2.6M12 18v3" />
    <path d="M3 3l18 18" />
  </Base>
);

export const Video = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="M16 10l5-3v10l-5-3" />
  </Base>
);

export const VideoOff = (p: IconProps) => (
  <Base {...p}>
    <path d="M16 10l5-3v10l-3-1.8M14 18H5a2 2 0 0 1-2-2V8a2 2 0 0 1 1.2-1.8" />
    <path d="M3 3l18 18" />
  </Base>
);

export const PhoneOff = (p: IconProps) => (
  <Base {...p}>
    <path d="M5.5 14.5a14 14 0 0 1-2.3-3.8c-.3-.8 0-1.7.7-2.2 1-.7 2.2-1.2 3.4-1.5M10.5 6.4A14 14 0 0 1 18 8.5c1.2.3 2.4.8 3.4 1.5.7.5 1 1.4.7 2.2a14 14 0 0 1-1.3 2.4" />
    <path d="M8 13c-.4 1-.3 1.6.2 2.1.6.6 2 1.4 3.8 1.7M3 3l18 18" />
  </Base>
);

export const Phone = (p: IconProps) => (
  <Base {...p}>
    <path d="M6.5 4h3l1.5 4-2 1.5a12 12 0 0 0 5 5L17 12l4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />
  </Base>
);

export const Plus = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

export const Users = (p: IconProps) => (
  <Base {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.2a3 3 0 0 1 0 5.6M17 14.2a5.5 5.5 0 0 1 3.5 4.8" />
  </Base>
);

export const Logout = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10" />
  </Base>
);

export const Smiley = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </Base>
);

export const Paperclip = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 11.5l-7.6 7.6a4.5 4.5 0 0 1-6.4-6.4l7.7-7.6a3 3 0 0 1 4.2 4.2l-7.6 7.6a1.5 1.5 0 0 1-2.1-2.1l6.9-6.9" />
  </Base>
);

export const DotsVertical = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="19" r="1" />
  </Base>
);

export const Search = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Base>
);

export const CheckCheck = (p: IconProps) => (
  <Base {...p}>
    <path d="M2 13l4 4 8-9M11 17l1 1 9-10" />
  </Base>
);

export const Camera = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13" r="3.5" />
  </Base>
);

export const ArrowLeft = (p: IconProps) => (
  <Base {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Base>
);
