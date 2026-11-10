// Small line icons drawn for the override (24px grid, 1.8 stroke).

const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

export const IconSearch = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
)

export const IconPlus = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconArrowUp = () => (
  <svg {...base} strokeWidth={2.2}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
)

export const IconStop = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </svg>
)

export const IconMic = () => (
  <svg {...base}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
  </svg>
)

export const IconPanel = () => (
  <svg {...base}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M14.5 4.5v15" />
  </svg>
)

/** The same frame with its divider on the left: the sidebar toggle. */
export const IconSidebar = () => (
  <svg {...base}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M9.5 4.5v15" />
  </svg>
)

export const IconChevron = () => (
  <svg {...base} strokeWidth={2.2}>
    <path d="m9 6 6 6-6 6" />
  </svg>
)

export const IconChevronDown = () => (
  <svg {...base} strokeWidth={2.2}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const IconClock = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.5l3 1.8" />
  </svg>
)

export const IconX = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

export const IconOpen = () => (
  <svg {...base}>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4" />
  </svg>
)

export const IconCopy = () => (
  <svg {...base}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </svg>
)

export const IconScreen = () => (
  <svg {...base}>
    <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </svg>
)

export const IconPin = () => (
  <svg {...base}>
    <path d="M9 4.5h6l-1 5 3 3v1.5H7V12.5l3-3zM12 14v6" />
  </svg>
)

export const IconSpark = () => (
  <svg {...base}>
    <path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M6.5 17.5 9 15M15 9l2.5-2.5" />
  </svg>
)

/** A file a bot sent (ui/Media.tsx FileCard): a page with a folded corner;
 *  `lines` adds text lines for text files. */
export const IconDocument = ({ lines = false }: { lines?: boolean }) => (
  <svg {...base} strokeWidth={1.6}>
    <path d="M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5Z" />
    <path d="M13.5 3.5V8H18" />
    {lines ? <path d="M9 12h6M9 15h6M9 18h4" /> : null}
  </svg>
)

export const IconDownload = () => (
  <svg {...base}>
    <path d="M12 4.5v10M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
  </svg>
)
