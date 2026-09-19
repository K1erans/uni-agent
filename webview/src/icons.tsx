import type { ReactNode } from 'react';

/** Line icons from the Paper design, drawn with the current text colour. Decorative: hidden from assistive tech. */

interface IconProps {
  size: number;
  className?: string;
}

interface IconFrameProps extends IconProps {
  children: ReactNode;
}

function Icon({ size, className, children }: IconFrameProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m7 10 5 5 5-5" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5m-6 6 6-6 6 6" />
    </Icon>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7V5h6l2 2h10v12H3Z" />
    </Icon>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10m0-4c8 0 12-1 12-5" />
    </Icon>
  );
}
