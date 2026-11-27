const fill = (d) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d}</svg>`;
const line = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICONS = {
  play: fill('<path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/>'),
  pause: fill('<rect x="6" y="4" width="4.2" height="16" rx="1.2"/><rect x="13.8" y="4" width="4.2" height="16" rx="1.2"/>'),
  next: fill('<path d="M4 6.2v11.6a1 1 0 0 0 1.55.83L14 13v4.8a1 1 0 0 0 1.55.83l7-5.8a1 1 0 0 0 0-1.66l-7-5.8A1 1 0 0 0 14 6.2V11L5.55 5.37A1 1 0 0 0 4 6.2z" transform="translate(-1 0)"/>'),
  prev: fill('<path d="M20 6.2v11.6a1 1 0 0 1-1.55.83L10 13v4.8a1 1 0 0 1-1.55.83l-7-5.8a1 1 0 0 1 0-1.66l7-5.8A1 1 0 0 1 10 6.2V11l8.45-5.63A1 1 0 0 1 20 6.2z" transform="translate(1 0)"/>'),
  shuffle: line('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>'),
  repeat: line('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  'repeat-one': line('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>'),
  more: fill('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>'),
  plus: line('<path d="M12 5v14M5 12h14"/>'),
  search: line('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  sync: line('<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/>'),
  cloud: line('<path d="M7 18a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 7.97"/><path d="M12 12v8"/><path d="m9 17 3 3 3-3"/>'),
  upload: line('<path d="M7 18a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 7.97"/><path d="M12 20v-8"/><path d="m9 15 3-3 3 3"/>'),
  'chevron-down': line('<path d="m6 9 6 6 6-6"/>'),
  'chevron-left': line('<path d="m15 18-6-6 6-6"/>'),
  'chevron-right': line('<path d="m9 18 6-6-6-6"/>'),
  library: line('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  playlists: line('<path d="M3 6h12M3 11h12M3 16h7"/><path d="M17 18V9l4-1"/><circle cx="15" cy="18" r="2"/>'),
  settings: line('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  trash: line('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/>'),
  edit: line('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  download: line('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  x: line('<path d="M18 6 6 18M6 6l12 12"/>'),
  'play-next': line('<path d="M3 6h12M3 12h12M3 18h7"/><path d="m16 15 5 3-5 3z"/>'),
  queue: line('<path d="M3 6h12M3 12h12M3 18h7"/><path d="M18 15v6M15 18h6"/>'),
  up: line('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  down: line('<path d="M12 5v14M5 12l7 7 7-7"/>'),
  telegram: line('<path d="m22 3-20 8 7 2 2 7 4-5 5 4z"/><path d="m9 13 13-10"/>'),
  file: line('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>'),
};

export const icon = (name) => ICONS[name] || '';
