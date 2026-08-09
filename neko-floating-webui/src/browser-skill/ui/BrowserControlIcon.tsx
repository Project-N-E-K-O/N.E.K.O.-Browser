interface BrowserControlIconProps {
  className?: string;
}

/** Browser window + pointer: explicitly communicates control of the current page. */
export function BrowserControlIcon({ className }: BrowserControlIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(0 1)">
        <rect
          x="2.75"
          y="4"
          width="18.5"
          height="15.5"
          rx="2"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <path d="M3.4 8.25h17.2" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="5.75" cy="6.15" r="0.75" fill="currentColor" />
        <circle cx="8.35" cy="6.15" r="0.75" fill="currentColor" fillOpacity="0.65" />
        <path
          d="m13.55 11.35 10.15 4.5-4.05 1.3 2.45 4.05-2.65 1.6-2.45-4.05-2.85 3.1-.6-10.5Z"
          fill="#174a68"
          stroke="white"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
