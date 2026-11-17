/**
 * Inline icon set. Original artwork, 1.5px stroke on a 16px grid — no icon
 * package, no borrowed glyphs.
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const ChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
)

export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3.5 6 4.5 4.5L12.5 6" />
  </Icon>
)

export const Plus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
)

export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3 3" />
  </Icon>
)

export const ArrowUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </Icon>
)

export const Stop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
  </Icon>
)

export const Sun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M12.6 3.4l-.85.85M4.25 11.75l-.85.85" />
  </Icon>
)

export const Moon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6Z" />
  </Icon>
)

export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3 8.5 3.2 3.2L13 5" />
  </Icon>
)

export const Alert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.6 14 13H2L8 2.6Z" />
    <path d="M8 6.6v3M8 11.2v.2" />
  </Icon>
)

export const Terminal = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="m5 6.5 2 1.75L5 10M8.8 10.2h2.4" />
  </Icon>
)

export const File = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2Z" />
    <path d="M9 2v4h4" />
  </Icon>
)

export const Folder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.4l1.3 1.6h5.3A1.5 1.5 0 0 1 14 7.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-7Z" />
  </Icon>
)

export const X = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
)

export const Sparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.9 3.9l2.1 2.1M10 10l2.1 2.1M12.1 3.9 10 6M6 10l-2.1 2.1" />
  </Icon>
)

export const Layers = (p: IconProps) => (
  <Icon {...p}>
    <path d="m8 2 6 3-6 3-6-3 6-3Z" />
    <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
  </Icon>
)
