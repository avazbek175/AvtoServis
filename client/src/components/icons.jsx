import React from 'react';

const paths = {
  wrench: 'M21.3 3.3a5.5 5.5 0 0 0-7.6 6.3L4 19.3a2.1 2.1 0 1 0 3 3l9.7-9.7a5.5 5.5 0 0 0 6.3-7.6l-3.4 3.4-2.6-.6-.6-2.6 2.9-2.9Z',
  engine: 'M5 7h3l1-2h6l1 2h3a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1l1 3H9l-2-3H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z M9 11h6 M9 14h4',
  diagnostic: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z M12 8v4l3 2 M3.5 9h4M3.5 15h4',
  chip: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 7h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z M12 9v6',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  oil: 'M6 4h12l-1.5 3h-9L6 4ZM10.5 7 9 19h6l1.5-12 M8 3h8',
  phone: 'M6.6 3h3l1.4 4-2 1.6a12 12 0 0 0 5.4 5.4L16 12l4 1.4v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3Z',
  telegram: 'M9.7 15.5 21 5M9.7 15.5 7.9 20c-.3.7-1.2.6-1.3-.1L5.5 9.1c0-.5.4-.9.9-1l15.2-3.4c.5-.1.9.3.8.8L9.7 15.5Z',
  instagram: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm5 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm5.5-1.5h.01',
  pin: 'M12 2a7 7 0 0 1 7 7c0 4.4-7 12-7 12S5 13.4 5 9a7 7 0 0 1 7-7Zm0 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm0 4.5V12l3 2',
  mail: 'M3 5h18v14H3V5Zm0 2 9 6 9-6',
  check: 'M5 12.5l5 5L20 6.5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  pluss: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  edit: 'M4 20h4L20 8a2.1 2.1 0 0 0-3-3L5 17l-1 3ZM14 6l3 3',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  lock: 'M6 11V8a6 6 0 1 1 12 0v3M4 11h16v10H4V11Z M12 15v3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm10 17-4.5-4.5',
  spark: 'M12 2l2.3 5.7L20 10l-5.7 2.3L12 18l-2.3-5.7L4 10l5.7-2.3L12 2ZM19 16l1 2.5L22.5 19 20 20l-1 2.5L18 20l-2.5-1L18 18.5 19 16Z',
  dashboard: 'M4 4h7v7H4V4Zm9 0h7v4h-7V4ZM4 13h7v7H4v-7Zm9 4h7v3h-7v-3Zm0-6h7v4h-7v-4Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.7 4a8.6 8.6 0 0 0-.2-1.8l2-1.6-2-3.4-2.4 1a8.6 8.6 0 0 0-3-1.8L14.7 2h-4L10 4.4a8.6 8.6 0 0 0-3 1.8l-2.4-1-2 3.4 2 1.6a8.6 8.6 0 0 0 0 3.6l-2 1.6 2 3.4 2.4-1a8.6 8.6 0 0 0 3 1.8L10.7 22h4l.3-2.4a8.6 8.6 0 0 0 3-1.8l2.4 1 2-3.4-2-1.6c.14-.59.2-1.2.2-1.8Z',
  image: 'M4 4h16v16H4V4Zm3 13 4-5 3 3 2-2 3 4M9.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3v-10.5Z',
  heart: 'M12 20s-7.5-4.6-9.5-9C1 7.5 3 4.5 6 4.5c2 0 3.5 1.2 4 2.6h4c.5-1.4 2-2.6 4-2.6 3 0 5 3 3.5 6.5-2 4.4-9.5 9-9.5 9Z',
  layout: 'M3 4h18v6H3V4Zm0 10h8v6H3v-6ZM15 14h6v6h-6v-6Z',
  logout: 'M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 8l4 4-4 4M20 12H9',
  copy: 'M8 8h11v11H8V8Zm0 0V5h11v3M5 8h3M5 10v9h3 M8 12h5M8 15h4',
  chevrondown: 'M6 9l6 6 6-6',
  chevronup: 'M6 15l6-6 6 6',
  chevronleft: 'M15 6l-6 6 6 6',
  chevronright: 'M9 6l6 6-6 6',
  updown: 'M7 8l5-5 5 5M7 16l5 5 5-5',
  document: 'M6 3h9l4 4v14H6V3ZM15 3v4h4M9 12h6M9 16h6M9 8h2',
  camera: 'M4 7h4l2-2h4l2 2h4a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z M12 11a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z M17.5 9.5h.01',
  calendar: 'M4 5h16v4H4V5Zm0 6h16v8H4v-8Z M7 3v4M17 3v4',
  money: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm-2 5v2h4v2h-4v5h2v-1a3 3 0 0 0 2-2M9 16h6',
};

export function Icon({ name, size = 24, className = '', strokeWidth = 1.8 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {renderPath(paths[name] || paths.wrench)}
    </svg>
  );
}

function renderPath(d) {
  const commands = d.split(/ M/);
  return commands.map((c, i) => <path key={i} d={(i === 0 ? '' : 'M') + c} />);
}

export default Icon;