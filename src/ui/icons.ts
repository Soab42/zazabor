const paths = {
  play: `<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>`,
  pause: `<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>`,
  prev: `<path d="M19 5v14L8.5 12z" fill="currentColor" stroke="none"/><path d="M6 5v14"/>`,
  next: `<path d="M5 5v14l10.5-7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>`,
  chevronLeft: `<path d="M15 5l-7 7 7 7"/>`,
  chevronRight: `<path d="M9 5l7 7-7 7"/>`,
  close: `<path d="M6 6l12 12M18 6L6 18"/>`,
  back: `<path d="M19 12H5M11 18l-6-6 6-6"/>`,
  zoomIn: `<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5l-4.9-4.9M11 8v6M8 11h6"/>`,
  zoomOut: `<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5l-4.9-4.9M8 11h6"/>`,
  fit: `<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>`,
  rotateLeft: `<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5L4.5 9"/><path d="M4.5 4v5h5"/>`,
  rotateRight: `<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5L19.5 9"/><path d="M19.5 4v5h-5"/>`,
  info: `<circle cx="12" cy="12" r="8.5"/><path d="M12 16.5v-5.5M12 7.75v.01"/>`,
  fullscreen: `<path d="M8.5 4H4v4.5M15.5 4H20v4.5M8.5 20H4v-4.5M15.5 20H20v-4.5"/>`,
  palette: `<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7h2a4 4 0 0 0 4-4c0-3.9-3.8-7.2-8.5-7.2z"/><circle cx="7.5" cy="11" r="1.1" fill="currentColor"/><circle cx="10.5" cy="7.3" r="1.1" fill="currentColor"/><circle cx="15.2" cy="7.8" r="1.1" fill="currentColor"/>`,
  settings: `<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>`,
  search: `<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5l-4.9-4.9"/>`,
  folder: `<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`,
  folderPlus: `<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>`,
  refresh: `<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>`,
  music: `<path d="M9 17.5V6l11-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/>`,
  volume: `<path d="M11 5.5L6.5 9H3.5v6h3l4.5 3.5z" fill="currentColor"/><path d="M15 9a4.5 4.5 0 0 1 0 6M17.8 6.2a8.5 8.5 0 0 1 0 11.6"/>`,
  mute: `<path d="M11 5.5L6.5 9H3.5v6h3l4.5 3.5z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>`,
  film: `<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M7.5 4v16M16.5 4v16M3.5 8.5h4M3.5 15.5h4M16.5 8.5h4M16.5 15.5h4"/>`,
  image: `<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="9.5" r="1.75"/><path d="M20.5 15.5l-5-5-9.5 9"/>`,
  sort: `<path d="M4 6.5h11M4 12h8M4 17.5h5M18 6v13M15 16l3 3 3-3"/>`,
  shuffle: `<path d="M3.5 7h3.2a4 4 0 0 1 3.3 1.8l4 6.4a4 4 0 0 0 3.3 1.8h3.2M3.5 17h3.2a4 4 0 0 0 3.3-1.8M14 8.8A4 4 0 0 1 17.3 7h3.2"/><path d="M18 4.5L20.5 7 18 9.5M18 14.5l2.5 2.5-2.5 2.5"/>`,
  star: `<path d="M12 3.8l2.5 5.1 5.6.8-4.05 3.95.95 5.6L12 16.6l-5 2.65.95-5.6L3.9 9.7l5.6-.8z"/>`,
  starFilled: `<path d="M12 3.8l2.5 5.1 5.6.8-4.05 3.95.95 5.6L12 16.6l-5 2.65.95-5.6L3.9 9.7l5.6-.8z" fill="currentColor"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
  checkSquare: `<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 12.2l2.5 2.5 4.8-5"/>`,
  lock: `<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="currentColor"/>`,
  eye: `<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.75"/>`,
  eyeOff: `<path d="M4 4l16 16M9.9 5.8A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.6 6.9C4.1 8.6 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.6-1.2"/><path d="M10 10.1a2.75 2.75 0 0 0 3.9 3.9"/>`,
  grid: `<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>`,
} as const;

export type IconName = keyof typeof paths;

export function icon(name: IconName, size = 18): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}
