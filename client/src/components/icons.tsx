import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

export function IconAgents(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconRepo(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M3 4h10v8H3z" />
      <path d="M6 4V2.5M10 4V2.5" />
      <path d="M5 8h6M5 10.5h4" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
    </svg>
  );
}

export function IconLogs(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M4 3h8v10H4z" />
      <path d="M6 6h4M6 8.5h4M6 11h2.5" />
    </svg>
  );
}

export function IconHelp(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6a1.8 1.8 0 013.1 1.2c0 1.2-1.3 1.5-1.3 2.8" />
      <circle cx="8" cy="12" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

export function IconLink(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M6.5 9.5l3-3M7 5.5l1.5-1.5a2.5 2.5 0 013.5 3.5L10.5 9M9 10.5L7.5 12a2.5 2.5 0 01-3.5-3.5L6.5 7" />
    </svg>
  );
}

export function IconBell(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M8 2a4 4 0 00-4 4v2.5L3 10h10l-1-1.5V6a4 4 0 00-4-4z" />
      <path d="M6.5 11a1.5 1.5 0 003 0" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M13 8a5 5 0 11-1.5-3.6M13 3v3.5H9.5" />
    </svg>
  );
}

export function IconKey(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="5.5" cy="10.5" r="2.5" />
      <path d="M7.5 8.5l5-5M10.5 3.5h2v2" />
    </svg>
  );
}

export function IconGithub(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M8 1.5a6.5 6.5 0 00-2.06 12.67c.325.06.445-.14.445-.31v-1.1c-1.81.39-2.19-.87-2.19-.87-.3-.75-.72-.95-.72-.95-.59-.4.045-.39.045-.39.65.045.99.67.99.67.58.99 1.52.7 1.89.54.06-.42.23-.7.42-.86-1.45-.16-2.97-.72-2.97-3.21 0-.71.25-1.28.67-1.74-.07-.16-.29-.82.06-1.71 0 0 .54-.17 1.77.66a6.1 6.1 0 011.62-.22c.55 0 1.1.07 1.62.22 1.23-.83 1.77-.66 1.77-.66.35.89.13 1.55.06 1.71.42.46.67 1.03.67 1.74 0 2.5-1.53 3.05-2.98 3.21.23.2.44.58.44 1.17v1.73c0 .17.12.37.45.31A6.5 6.5 0 008 1.5z" />
    </svg>
  );
}

export function IconWebhook(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M3 8h4l2-4 2 8 2-4h4" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M3.5 8.5l3 3 6-6" />
    </svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M2 5.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 4H3a1 1 0 00-1 1v.5z" />
    </svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4M8 5v.5" />
    </svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5.5a2.5 2.5 0 015 0V7" />
    </svg>
  );
}

export function IconChart(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M2 12h12M5 12V7M8 12V4M11 12V9" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M2 2l12 12M6.5 6.7A3.5 3.5 0 0012 8M4.5 4.9A7 7 0 011.5 8s2.5 4 6.5 4a6.5 6.5 0 003.5-1M10 10.3A3.5 3.5 0 005 8" />
    </svg>
  );
}
