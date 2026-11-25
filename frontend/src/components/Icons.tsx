import React from 'react';

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect width="28" height="28" rx="6" fill="#0D5C48" />
      <path
        d="M14 5.5L21 8.5V14.2C21 18.4 17.9 21.8 14 23C10.1 21.8 7 18.4 7 14.2V8.5L14 5.5Z"
        stroke="#FFFFFF"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M11 14.2L13.1 16.3L17.4 11.8"
        stroke="#7CE3C4"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ShieldAlertIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2.5L16.5 5.2V10.1C16.5 13.8 13.7 16.9 10 18C6.3 16.9 3.5 13.8 3.5 10.1V5.2L10 2.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M10 6.8V10.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="10" cy="13.4" r="0.95" fill="currentColor" />
    </svg>
  );
}

export function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.2 8.4L6.4 11.5L12.8 4.8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.2" y="7.2" width="9.6" height="6.8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.4 7.2V5.3C5.4 3.85 6.55 2.7 8 2.7C9.45 2.7 10.6 3.85 10.6 5.3V7.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function RefreshIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.3 8A5.3 5.3 0 1 1 11.7 4.2M13.3 2.8V5.5H10.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4.5H13M6 4.5V3.1C6 2.7 6.3 2.4 6.7 2.4H9.3C9.7 2.4 10 2.7 10 3.1V4.5M4.5 4.5L5.1 13.1C5.15 13.6 5.55 14 6.05 14H9.95C10.45 14 10.85 13.6 10.9 13.1L11.5 4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ExternalIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 3H13V6.5M13 3L7.5 8.5M11.5 9.2V12.2C11.5 12.64 11.14 13 10.7 13H3.8C3.36 13 3 12.64 3 12.2V5.3C3 4.86 3.36 4.5 3.8 4.5H6.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
