import { db } from './db.js';
import * as api from './api.js';
import { player } from './player.js';
import { icon } from './icons.js';

const APP_VERSION = 'v10'; // keep in sync with VERSION in sw.js

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => crypto.randomUUID();
const fmtTime = (s) => {
  s = isFinite(s) && s > 0 ? Math.floor(s) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtTotal = (s) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const fmtBytes = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.round(b / 1024)} KB`);
const hue = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const initial = (s) => ([...String(s || '').trim()][0] || '♪').toUpperCase();
// Artwork tile: the cover image when there is one, otherwise a coloured letter.
// coverId lets a playlist borrow a track's cover.
const art = (id, name, cls = '', coverId = id) => {
  const url = coverUrlFor(coverId);
  if (url) return `<div class="art has-img ${cls}" style="--h:${hue(id)};background-image:url('${url}')"></div>`;
  const wants = state.tracks.get(coverId)?.cover;
  return `<div class="art ${cls}" style="--h:${hue(id)}"${wants ? ` data-cover="${coverId}"` : ''}>${esc(initial(name))}</div>`;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const newestFirst = (a, b) => b.addedAt - a.addedAt;

const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|wav|wave|aif|aiff|flac|alac|caf|ogg|oga|opus|webm)$/i;
const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', wave: 'audio/wav',
  aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac', alac: 'audio/mp4', caf: 'audio/x-caf',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
};
const guessType = (name) => MIME_BY_EXT[(name.split('.').pop() || '').toLowerCase()] || '';
const stripExt = (name) => name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();

// ---------- state ----------
const state = {
  tracks: new Map(),
  downloaded: new Set(),
  downloading: new Set(),
  playlists: { updatedAt: 0, items: [] },
  settings: { serverUrl: '', token: '', autoDownload: true, sort: 'new', libraryId: '', storageLimitMB: 1024 },
  pending: { uploads: [], deletes: [], renames: [], playlistsDirty: false },
  view: { name: 'library' },
  search: '',
  libTab: 'songs', // songs | artists
  recent: [],      // [{ type: 'track'|'playlist'|'artist', id, at }]
  syncing: false,
  syncError: '',
  telegram: null,
  lastSync: 0,
};
let listIds = []; // track ids currently shown, in order (used as the play queue)

const configured = () => api.isConfigured(state.settings);
const saveSettings = () => db.put('kv', state.settings, 'settings');
const savePending = () => db.put('kv', state.pending, 'pending');
const savePlaylistsLocal = () => db.put('kv', state.playlists, 'playlists');
const findPlaylist = (id) => state.playlists.items.find((p) => p.id === id);
const playlistTracks = (pl) => pl.trackIds.map((id) => state.tracks.get(id)).filter(Boolean);
const isPendingUpload = (id) => state.pending.uploads.includes(id);
const isLocalOnly = (id) => !!state.tracks.get(id)?.localOnly;
const cloudCopy = (id) => !isPendingUpload(id) && !isLocalOnly(id);

function changePlaylists(fn) {
  fn(state.playlists.items);
  state.playlists.updatedAt = Date.now();
  state.pending.playlistsDirty = true;
  savePlaylistsLocal();
  savePending();
  scheduleSync();
}

// ---------- cover art ----------
// Covers are fetched from the server once and kept on the phone (works offline).
const coverUrls = new Map(); // track id -> { key, url }
const coverJobs = new Map();
let coverActive = 0;
const coverQueue = [];

function coverUrlFor(id) {
  const t = state.tracks.get(id);
  const c = t?.cover && coverUrls.get(id);
  return c && c.key === t.cover ? c.url : null;
}

function limited(fn) {
  return new Promise((resolve, reject) => {
    coverQueue.push(() => fn().then(resolve, reject));
    pumpCovers();
  });
}
function pumpCovers() {
  while (coverActive < 4 && coverQueue.length) {
    coverActive++;
    coverQueue.shift()().finally(() => { coverActive--; pumpCovers(); });
  }
}

function loadCover(id) {
  const t = state.tracks.get(id);
  if (!t?.cover) return Promise.resolve(null);
  const ready = coverUrlFor(id);
  if (ready) return Promise.resolve(ready);
  if (coverJobs.has(id)) return coverJobs.get(id);
  const job = (async () => {
    let rec = await db.get('kv', `cover:${id}`);
    if (!rec || rec.key !== t.cover) {
      if (!configured() || !navigator.onLine) return null;
      const blob = await limited(() => api.getCover(state.settings, id)).catch(() => null);
      if (!blob) return null;
      rec = { key: t.cover, blob };
      await db.put('kv', rec, `cover:${id}`);
    }
    const old = coverUrls.get(id);
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(rec.blob);
    coverUrls.set(id, { key: rec.key, url });
    if (id === player.currentId) { paintPlayerArt(); player.updateMetadata(); }
    return url;
  })().finally(() => coverJobs.delete(id));
  coverJobs.set(id, job);
  return job;
}

function hydrateCovers(root = document) {
  $$('[data-cover]', root).forEach((el) => {
    const id = el.dataset.cover;
    el.removeAttribute('data-cover');
    loadCover(id).then((url) => {
      if (!url || !el.isConnected) return;
      el.classList.add('has-img');
      el.style.backgroundImage = `url('${url}')`;
      el.textContent = '';
    });
  });
}

// Playlist artwork: 4+ songs with covers -> 2x2 grid, 1-3 -> the first cover, none -> letter tile.
function playlistArt(pl, cls = '') {
  const ids = [...new Set(pl.trackIds)].filter((id) => state.tracks.get(id)?.cover).slice(0, 4);
  if (ids.length < 4) return art(pl.id, pl.name, cls, ids[0] || pl.id);
  const cells = ids.map((id) => {
    const url = coverUrlFor(id);
    return url ? `<div class="has-img" style="background-image:url('${url}')"></div>` : `<div data-cover="${id}"></div>`;
  });
  return `<div class="art mosaic ${cls}">${cells.join('')}</div>`;
}

// Lock-screen artwork: a vinyl record with the cover as its label.
// (iOS draws the lock screen itself, so it can't spin there, but it looks like a record.)
const vinylArt = new Map(); // track id -> { key, url }
const vinylJobs = new Map();
function lockScreenArtwork(id) {
  const t = state.tracks.get(id);
  if (!t) return null;
  const key = `${t.cover || ''}|${t.title}`;
  const ready = vinylArt.get(id);
  if (ready && ready.key === key) return ready.url;
  if (!vinylJobs.has(id)) {
    const job = makeVinylArt(t, key)
      .then((url) => { if (url && id === player.currentId) player.updateMetadata(); })
      .catch(() => {})
      .finally(() => vinylJobs.delete(id));
    vinylJobs.set(id, job);
  }
  return ready?.url || null;
}

async function makeVinylArt(t, key) {
  const coverUrl = t.cover ? await loadCover(t.id) : null;
  const S = 600;
  const c = S / 2;
  const R = S * 0.47;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const h = hue(t.id);

  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, `hsl(${h} 38% 20%)`);
  bg.addColorStop(1, '#0d0d0f');
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);

  // record + grooves
  g.save();
  g.shadowColor = 'rgba(0,0,0,.6)';
  g.shadowBlur = 30;
  g.shadowOffsetY = 12;
  g.fillStyle = '#121214';
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();
  g.restore();
  for (let r = R * 0.4; r < R * 0.97; r += 3.2) {
    g.strokeStyle = `rgba(255,255,255,${0.025 + (Math.sin(r * 0.37) + 1) * 0.012})`;
    g.lineWidth = 1;
    g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke();
  }
  // light reflection
  g.save();
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.clip();
  const sheen = g.createLinearGradient(0, 0, S, S);
  sheen.addColorStop(0.3, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,.08)');
  sheen.addColorStop(0.55, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, S, S);
  g.restore();

  // label: the cover, or a coloured label with the first letter
  const L = R * 0.38;
  g.save();
  g.beginPath(); g.arc(c, c, L, 0, Math.PI * 2); g.clip();
  let drewCover = false;
  if (coverUrl) {
    try {
      const img = new Image();
      img.src = coverUrl;
      await img.decode();
      const scale = Math.max((L * 2) / img.width, (L * 2) / img.height);
      const w = img.width * scale;
      const hh = img.height * scale;
      g.drawImage(img, c - w / 2, c - hh / 2, w, hh);
      drewCover = true;
    } catch {}
  }
  if (!drewCover) {
    const lg = g.createLinearGradient(c - L, c - L, c + L, c + L);
    lg.addColorStop(0, `hsl(${h} 72% 56%)`);
    lg.addColorStop(1, `hsl(${h + 45} 62% 30%)`);
    g.fillStyle = lg;
    g.fillRect(c - L, c - L, L * 2, L * 2);
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.font = `700 ${Math.round(L * 0.9)}px -apple-system, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(initial(t.title), c, c + L * 0.05);
  }
  g.restore();
  g.strokeStyle = 'rgba(0,0,0,.5)';
  g.lineWidth = 3;
  g.beginPath(); g.arc(c, c, L, 0, Math.PI * 2); g.stroke();

  // spindle
  g.fillStyle = '#d8d8dc';
  g.beginPath(); g.arc(c, c, S * 0.016, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.45)';
  g.lineWidth = 4;
  g.stroke();

  const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const old = vinylArt.get(t.id);
  if (old) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(blob);
  vinylArt.set(t.id, { key, url });
  return url;
}

function paintArt(el, t) {
  const url = coverUrlFor(t.id);
  el.style.setProperty('--h', hue(t.id));
  el.classList.toggle('has-img', !!url);
  el.style.backgroundImage = url ? `url('${url}')` : '';
  el.textContent = url ? '' : initial(t.title);
  if (!url && t.cover) loadCover(t.id);
}

function paintPlayerArt() {
  const t = state.tracks.get(player.currentId);
  if (!t) return;
  paintArt($('#miniArt'), t);
  paintArt($('#pArt'), t);
}

function applyServerTrack(st) {
  const t = state.tracks.get(st.id);
  if (!t) return;
  t.cover = st.cover;
  db.put('tracks', t);
  renderView();
  renderPlayer();
  if (st.id === player.currentId) player.updateMetadata();
}

async function findMissingCovers() {
  try {
    toast('Looking for covers…');
    let found = 0;
    for (let i = 0; i < 100; i++) {
      const r = await api.findMissingCovers(state.settings);
      found += r.found;
      if (!r.remaining || !r.checked) break;
      toast(`Looking for covers… ${r.remaining} left`);
    }
    toast(found ? `Found ${plural(found, 'cover')}` : 'No new covers found');
    await sync();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- audio files ----------
const inflight = new Map();
async function ensureBlob(id) {
  const cached = await db.get('blobs', id);
  if (cached) return cached;
  if (inflight.has(id)) return inflight.get(id);
  if (!configured()) throw new Error("This track isn't on this phone");
  if (!navigator.onLine) throw new Error("You're offline and this track isn't downloaded");
  const job = (async () => {
    state.downloading.add(id);
    updateStatus(id);
    try {
      const t = state.tracks.get(id);
      let blob = await api.downloadAudio(state.settings, id);
      if (t?.type && blob.type !== t.type) blob = new Blob([blob], { type: t.type });
      await db.put('blobs', blob, id);
      state.downloaded.add(id);
      if (t && t.size !== blob.size) { t.size = blob.size; await db.put('tracks', t); }
      await enforceStorageLimit(id);
      return blob;
    } finally {
      state.downloading.delete(id);
      inflight.delete(id);
      updateStatus(id);
    }
  })();
  inflight.set(id, job);
  return job;
}

// ---------- storage limit ----------
// Downloads are capped (1 GB by default). When the phone goes over, the tracks
// you played longest ago are removed from the phone; they stay in Telegram and
// download again when you play them.
const limitBytes = () => (state.settings.storageLimitMB > 0 ? state.settings.storageLimitMB * 1048576 : Infinity);
const downloadedBytes = () => [...state.downloaded].reduce((sum, id) => sum + (state.tracks.get(id)?.size || 0), 0);
const lastUsed = (t) => t.lastPlayed || t.addedAt || 0;

async function enforceStorageLimit(keepId) {
  const limit = limitBytes();
  let used = downloadedBytes();
  if (used <= limit) return;
  // Never remove: what's playing, the next two in the queue, the track just
  // downloaded, and files that only exist on this phone.
  const keep = new Set([keepId, ...player.queue.slice(Math.max(0, player.index), player.index + 3)]);
  const candidates = [...state.downloaded]
    .map((id) => state.tracks.get(id))
    .filter((t) => t && !keep.has(t.id) && cloudCopy(t.id))
    .sort((a, b) => lastUsed(a) - lastUsed(b));
  for (const t of candidates) {
    if (used <= limit) break;
    await db.del('blobs', t.id);
    state.downloaded.delete(t.id);
    used -= t.size || 0;
    updateStatus(t.id);
  }
  refreshStorageInfo();
}

function markPlayed(id) {
  const t = state.tracks.get(id);
  if (!t) return;
  t.lastPlayed = Date.now();
  db.put('tracks', t);
}

let bgRunning = false;
async function backgroundDownload(loud = false) {
  if (bgRunning || !configured()) return;
  bgRunning = true;
  try {
    // Fill the phone up to the limit with your newest tracks, without pushing
    // out anything (so it never downloads and deletes in a loop).
    let used = downloadedBytes();
    for (const t of [...state.tracks.values()].sort(newestFirst)) {
      if (!navigator.onLine) break;
      if (state.downloaded.has(t.id)) continue;
      if (used + (t.size || 0) > limitBytes()) {
        if (loud) toast('Storage limit reached — change it in Settings');
        break;
      }
      try { await ensureBlob(t.id); used = downloadedBytes(); } catch (err) { if (loud) toast(err.message); break; }
    }
  } finally {
    bgRunning = false;
    refreshStorageInfo();
  }
}

function probeDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(isFinite(d) ? d : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(a.duration);
    a.onerror = () => finish(0);
    setTimeout(() => finish(0), 8000);
    a.src = url;
  });
}

async function importFiles(files) {
  let count = 0;
  const base = Date.now();
  for (const file of files) {
    const type = file.type || guessType(file.name);
    if (!type.startsWith('audio/') && !AUDIO_EXT.test(file.name)) continue;
    const blob = new Blob([await file.arrayBuffer()], { type: type || 'audio/mpeg' });
    const t = {
      id: uid(),
      title: stripExt(file.name) || 'Untitled',
      filename: file.name,
      artist: '',
      duration: await probeDuration(blob),
      size: blob.size,
      type: blob.type,
      addedAt: base + count,
    };
    await db.put('blobs', blob, t.id);
    await db.put('tracks', t);
    state.tracks.set(t.id, t);
    state.downloaded.add(t.id);
    state.pending.uploads.push(t.id);
    count++;
  }
  await savePending();
  toast(count ? `Imported ${plural(count, 'track')}` : 'No audio files found');
  renderView();
  scheduleSync(300);
}

async function removeTrackLocally(id) {
  db.del('kv', `cover:${id}`);
  state.tracks.delete(id);
  state.downloaded.delete(id);
  await db.del('tracks', id);
  await db.del('blobs', id);
  player.removeTrack(id);
}

// ---------- sync ----------
let syncTimer = null;
let syncAgain = false;
function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), delay);
}

async function sync(manual = false) {
  if (!configured()) return;
  if (state.syncing) { syncAgain = true; return; }
  if (!navigator.onLine) {
    state.syncError = 'Offline';
    renderSyncStatus();
    if (manual) toast("You're offline");
    return;
  }
  state.syncing = true;
  state.syncError = '';
  renderSyncStatus();
  const s = state.settings;
  const p = state.pending;
  try {
    // A different server/bucket than last time? Re-upload what this phone has.
    let lib = await api.getLibrary(s);
    if (s.libraryId && lib.libraryId !== s.libraryId) {
      const serverIds = new Set(lib.tracks.map((t) => t.id));
      for (const id of state.downloaded) if (!serverIds.has(id) && !p.uploads.includes(id) && !isLocalOnly(id)) p.uploads.push(id);
      p.playlistsDirty = true;
    }
    if (s.libraryId !== lib.libraryId) { s.libraryId = lib.libraryId; await saveSettings(); }

    let pushed = false;
    for (const id of [...p.deletes]) {
      try { await api.deleteTrack(s, id); } catch (err) { if (err.status !== 404) throw err; }
      p.deletes = p.deletes.filter((x) => x !== id);
      await savePending();
      pushed = true;
    }
    let uploadProblem = '';
    for (const id of [...p.uploads]) {
      const t = state.tracks.get(id);
      const blob = t && (await db.get('blobs', id));
      if (t && blob) {
        try {
          await api.uploadTrack(s, t, blob);
        } catch (err) {
          if (err.status === 413) {
            // Too big for Telegram: keep it on this phone only.
            t.localOnly = true;
            await db.put('tracks', t);
            toast(`“${t.title}” is over 20 MB, so it stays on this phone only`);
          } else if (err.status === 409) {
            uploadProblem = err.message; // bot not connected yet: try again later
            break;
          } else {
            throw err;
          }
        }
      }
      p.uploads = p.uploads.filter((x) => x !== id);
      await savePending();
      updateStatus(id);
      pushed = true;
    }
    for (const id of [...p.renames]) {
      const t = state.tracks.get(id);
      if (t) { try { await api.updateTrack(s, t); } catch (err) { if (err.status !== 404) throw err; } }
      p.renames = p.renames.filter((x) => x !== id);
      await savePending();
      pushed = true;
    }
    if (p.playlistsDirty) {
      p.playlistsDirty = false;
      await api.savePlaylists(s, state.playlists);
      await savePending();
      pushed = true;
    }
    if (pushed) lib = await api.getLibrary(s);

    let changed = false;
    if (!p.playlistsDirty && lib.playlists && lib.playlists.updatedAt !== state.playlists.updatedAt) {
      state.playlists = { updatedAt: lib.playlists.updatedAt, items: lib.playlists.items || [] };
      await savePlaylistsLocal();
      changed = true;
    }
    const serverIds = new Set();
    for (const st of lib.tracks) {
      serverIds.add(st.id);
      if (p.renames.includes(st.id)) continue;
      const lt = state.tracks.get(st.id);
      const merged = { ...lt, ...st, duration: st.duration || lt?.duration || 0 };
      if (!lt || lt.title !== merged.title || lt.artist !== merged.artist || lt.duration !== merged.duration || lt.size !== merged.size || lt.cover !== merged.cover) {
        state.tracks.set(st.id, merged);
        await db.put('tracks', merged);
        changed = true;
      }
    }
    for (const id of [...state.tracks.keys()]) {
      if (!serverIds.has(id) && !p.uploads.includes(id) && !state.tracks.get(id)?.localOnly) { await removeTrackLocally(id); changed = true; }
    }
    state.lastSync = Date.now();
    state.telegram = lib.telegram || null;
    if (uploadProblem) state.syncError = uploadProblem;
    if (changed) renderView();
    if (s.autoDownload) backgroundDownload();
    if (manual) toast('Synced');
  } catch (err) {
    state.syncError = err.message;
    if (manual) toast(err.message);
  } finally {
    state.syncing = false;
    renderSyncStatus();
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

// ---------- rendering ----------
function render() {
  renderView();
  renderSyncStatus();
  renderPlayer();
}

function renderTabs() {
  const active = state.view.name === 'playlist' ? 'playlists' : state.view.name === 'artist' ? 'library' : state.view.name;
  $('#importBtn').hidden = state.view.name !== 'library';
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === active));
}

function renderView() {
  renderTabs();
  const v = state.view;
  const el = $('#view');
  if (v.name === 'library') {
    $('#pageTitle').textContent = 'Library';
    el.innerHTML = libraryHTML();
    renderList();
  } else if (v.name === 'playlists') {
    $('#pageTitle').textContent = 'Playlists';
    el.innerHTML = playlistsHTML();
    hydrateCovers(el);
  } else if (v.name === 'artist') {
    const a = artistIndex().get(v.key);
    if (!a) { state.view = { name: 'library' }; state.libTab = 'artists'; return renderView(); }
    $('#pageTitle').textContent = 'Library';
    el.innerHTML = artistHTML(a);
    hydrateCovers(el);
    renderList();
  } else if (v.name === 'playlist') {
    const pl = findPlaylist(v.id);
    if (!pl) { state.view = { name: 'playlists' }; return renderView(); }
    $('#pageTitle').textContent = 'Playlists';
    el.innerHTML = playlistHTML(pl);
    hydrateCovers(el);
    renderList();
  } else {
    $('#pageTitle').textContent = 'Settings';
    el.innerHTML = settingsHTML();
    refreshStorageInfo();
  }
}

function libraryTracks() {
  let list = [...state.tracks.values()];
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((t) => `${t.title} ${t.artist || ''}`.toLowerCase().includes(q));
  if (state.settings.sort === 'az') list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  else list.sort(newestFirst);
  return list;
}

function libraryHTML() {
  const sortLabel = state.settings.sort === 'az' ? 'A–Z' : 'Newest';
  const songs = state.libTab === 'songs';
  return `
    <label class="search">${icon('search')}<input id="search" type="search" placeholder="${songs ? 'Search your tracks' : 'Search artists'}" value="${esc(state.search)}" autocomplete="off" autocorrect="off"></label>
    <div class="seg">
      <button data-action="lib-tab" data-lib="songs" class="${songs ? 'on' : ''}">Songs</button>
      <button data-action="lib-tab" data-lib="artists" class="${songs ? '' : 'on'}">Artists</button>
    </div>
    <div id="recent"></div>
    ${songs ? `<div class="actions-row">
      <button class="pill primary" data-action="play-list">${icon('play')} Play</button>
      <button class="pill" data-action="shuffle-list">${icon('shuffle')} Shuffle</button>
      <span class="grow"></span>
      <button class="pill ghost" data-action="sort">${sortLabel}</button>
    </div>` : ''}
    <div id="list" class="list"></div>`;
}

// ---------- artists ----------
// Songs with several artists ("A, B" or "A feat. B") show up under each of them.
const splitArtists = (s) => String(s || '').split(/\s*(?:,|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i).map((x) => x.trim()).filter(Boolean);
const artistKey = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();

function artistIndex() {
  const map = new Map();
  for (const t of [...state.tracks.values()].sort(newestFirst)) {
    for (const name of splitArtists(t.artist)) {
      const key = artistKey(name);
      if (!map.has(key)) map.set(key, { key, name, ids: [] });
      map.get(key).ids.push(t.id);
    }
  }
  return map;
}

const artistCoverId = (a) => a.ids.find((id) => state.tracks.get(id)?.cover) || a.ids[0];

function artistHTML(a) {
  const ts = a.ids.map((id) => state.tracks.get(id)).filter(Boolean);
  const total = ts.reduce((s, t) => s + (t.duration || 0), 0);
  return `
    <button class="back" data-action="back-artists">${icon('chevron-left')} Artists</button>
    <div class="pl-head">
      ${art(a.key, a.name, 'big round', artistCoverId(a))}
      <div class="meta"><h2>${esc(a.name)}</h2><div class="muted small">${plural(ts.length, 'track')}${total ? ` · ${fmtTotal(total)}` : ''}</div></div>
    </div>
    <div class="actions-row">
      <button class="pill primary" data-action="play-list">${icon('play')} Play</button>
      <button class="pill" data-action="shuffle-list">${icon('shuffle')} Shuffle</button>
    </div>
    <div id="list" class="list"></div>`;
}

// ---------- recently played ----------
function addRecent(item) {
  state.recent = [{ ...item, at: Date.now() }, ...state.recent.filter((r) => !(r.type === item.type && r.id === item.id))].slice(0, 12);
  db.put('kv', state.recent, 'recent');
  renderRecent();
}

function recentEntries() {
  const artists = artistIndex();
  return state.recent.map((r) => {
    if (r.type === 'track') { const t = state.tracks.get(r.id); return t && { r, label: t.title, sub: t.artist || 'Song', html: art(t.id, t.title) }; }
    if (r.type === 'playlist') { const pl = findPlaylist(r.id); return pl && { r, label: pl.name, sub: 'Playlist', html: playlistArt(pl) }; }
    if (r.type === 'artist') { const a = artists.get(r.id); return a && { r, label: a.name, sub: 'Artist', html: art(a.key, a.name, 'round', artistCoverId(a)) }; }
    return null;
  }).filter(Boolean).slice(0, 10);
}

function renderRecent() {
  const el = $('#recent');
  if (!el) return;
  const items = state.libTab === 'songs' && !state.search ? recentEntries() : [];
  el.innerHTML = items.length
    ? `<h3 class="section-title">Recently played</h3><div class="recent-row">${items.map(({ r, label, sub, html }) =>
        `<button class="recent-item" data-action="open-recent" data-type="${r.type}" data-id="${esc(r.id)}">${html}<span class="t">${esc(label)}</span><span class="s">${esc(sub)}</span></button>`).join('')}</div>`
    : '';
  hydrateCovers(el);
}

// Where the play buttons on the current screen start playback from (for "Recently played").
function currentContext() {
  if (state.view.name === 'playlist') return { type: 'playlist', id: state.view.id };
  if (state.view.name === 'artist') return { type: 'artist', id: state.view.key };
  return null;
}

function playlistsHTML() {
  const items = state.playlists.items;
  const rows = items.map((pl) => {
    const n = playlistTracks(pl).length;
    return `<div class="row" data-action="open-playlist" data-id="${esc(pl.id)}">
      ${playlistArt(pl)}
      <div class="meta"><div class="t">${esc(pl.name)}</div><div class="s">${plural(n, 'track')}</div></div>
      <span class="chev">${icon('chevron-right')}</span>
    </div>`;
  }).join('');
  return `
    <div class="actions-row"><button class="pill primary" data-action="new-playlist">${icon('plus')} New playlist</button></div>
    <div class="list">${rows || emptyHTML('No playlists yet', 'Make one to group your tracks.')}</div>`;
}

function playlistHTML(pl) {
  const ts = playlistTracks(pl);
  const total = ts.reduce((a, t) => a + (t.duration || 0), 0);
  const dis = ts.length ? '' : 'disabled';
  return `
    <button class="back" data-action="tab" data-tab="playlists">${icon('chevron-left')} Playlists</button>
    <div class="pl-head">
      ${playlistArt(pl, 'big')}
      <div class="meta"><h2>${esc(pl.name)}</h2><div class="muted small">${plural(ts.length, 'track')}${total ? ` · ${fmtTotal(total)}` : ''}</div></div>
    </div>
    <div class="actions-row">
      <button class="pill primary" data-action="play-list" ${dis}>${icon('play')} Play</button>
      <button class="pill" data-action="shuffle-list" ${dis}>${icon('shuffle')} Shuffle</button>
      <button class="pill" data-action="add-songs">${icon('plus')} Add</button>
      <span class="grow"></span>
      <button class="icon-btn more" data-action="playlist-menu" aria-label="Playlist options">${icon('more')}</button>
    </div>
    <div id="list" class="list"></div>`;
}

function settingsHTML() {
  const s = state.settings;
  return `
    <section class="card">
      <h3>Cloud sync</h3>
      <p class="muted small">Connect to your server so your library and playlists sync everywhere.</p>
      <label class="field"><span>Server URL</span><input id="serverUrl" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://selftape-api.you.workers.dev" value="${esc(s.serverUrl)}"></label>
      <label class="field"><span>App password</span><input id="token" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(s.token)}"></label>
      <div class="row-btns">
        <button class="pill primary" data-action="save-server">Save & sync</button>
        ${configured() ? '<button class="pill" data-action="sync">Sync now</button>' : ''}
      </div>
      <p class="muted small" id="syncStatus"></p>
    </section>
    <section class="card">
      <h3>Telegram bot</h3>
      <p class="muted small">Your music is stored in Telegram. After connecting, add the bot as an admin of your music channel: everything you post there shows up here. You can also send or forward tracks to the bot. Files up to 20 MB.</p>
      ${state.telegram?.channel ? `<p class="small">📻 Linked to <b>${esc(state.telegram.channel)}</b></p>` : ''}
      <button class="pill" data-action="connect-telegram" ${configured() ? '' : 'disabled'}>${icon('telegram')} Connect bot</button>
    </section>
    <section class="card">
      <h3>On this phone</h3>
      <label class="toggle"><span>Download new tracks automatically</span><input type="checkbox" id="autoDownload" ${s.autoDownload ? 'checked' : ''}></label>
      <label class="toggle"><span>Max storage on this phone</span>
        <select id="storageLimit" class="select">
          ${[[512, '500 MB'], [1024, '1 GB'], [2048, '2 GB'], [5120, '5 GB'], [0, 'No limit']].map(([v, l]) => `<option value="${v}" ${Number(s.storageLimitMB) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <p class="muted small">When it's full, the songs you played longest ago are removed from the phone. They stay in Telegram and download again when you play them.</p>
      <p class="muted small" id="storageInfo">&nbsp;</p>
      <div class="row-btns">
        <button class="pill" data-action="import">${icon('file')} Import from Files</button>
        ${configured() ? `<button class="pill" data-action="download-all">${icon('download')} Download all</button>
        <button class="pill" data-action="remove-downloads">Free up space</button>
        <button class="pill" data-action="find-covers">${icon('search')} Find missing covers</button>` : ''}
      </div>
    </section>
    <section class="card">
      <h3>Install on iPhone</h3>
      <p class="muted small">Open this page in Safari, tap the Share button, then <b>Add to Home Screen</b>. It opens full-screen like a normal app and works offline.</p>
    </section>
    <p class="muted small" style="text-align:center">Selftape ${APP_VERSION}</p>`;
}

const emptyHTML = (title, sub) => `<div class="empty"><div class="t">${esc(title)}</div><div class="s wrap">${sub}</div></div>`;

function statusIcon(id) {
  if (state.downloading.has(id)) return '<span class="spinner"></span>';
  if (isPendingUpload(id)) return icon('upload');
  if (isLocalOnly(id)) return '<span class="tag">phone only</span>';
  if (!state.downloaded.has(id)) return icon('cloud');
  return '';
}

function rowHTML(t, pos, index = '') {
  const sub = [t.artist, t.duration ? fmtTime(t.duration) : ''].filter(Boolean).join(' · ');
  return `<div class="row${player.currentId === t.id ? ' playing' : ''}" data-action="play-row" data-pos="${pos}" data-id="${t.id}">
    ${art(t.id, t.title)}
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${esc(sub) || '&nbsp;'}</div></div>
    <span class="status" data-status="${t.id}">${statusIcon(t.id)}</span>
    <button class="icon-btn more" data-action="track-menu" data-id="${t.id}" data-index="${index}" aria-label="More">${icon('more')}</button>
  </div>`;
}

function renderList() {
  const el = $('#list');
  if (!el) return;
  if (state.view.name === 'library' && state.libTab === 'artists') {
    const q = state.search.trim().toLowerCase();
    const list = [...artistIndex().values()]
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    listIds = [];
    el.innerHTML = list.length
      ? list.map((a) => `<div class="row" data-action="open-artist" data-key="${esc(a.key)}">
          ${art(a.key, a.name, 'round', artistCoverId(a))}
          <div class="meta"><div class="t">${esc(a.name)}</div><div class="s">${plural(a.ids.length, 'track')}</div></div>
          <span class="chev">${icon('chevron-right')}</span>
        </div>`).join('')
      : emptyHTML(q ? 'Nothing found' : 'No artists yet', q ? 'Try a different search.' : 'Add the artist to your songs with ••• → Edit title & artist.');
  } else if (state.view.name === 'artist') {
    const a = artistIndex().get(state.view.key);
    const ts = a ? a.ids.map((id) => state.tracks.get(id)).filter(Boolean) : [];
    listIds = ts.map((t) => t.id);
    el.innerHTML = ts.map((t, i) => rowHTML(t, i)).join('');
  } else if (state.view.name === 'library') {
    renderRecent();
    const ts = libraryTracks();
    listIds = ts.map((t) => t.id);
    el.innerHTML = ts.length
      ? ts.map((t, i) => rowHTML(t, i)).join('')
      : state.search
        ? emptyHTML('Nothing found', 'Try a different search.')
        : emptyHTML('No tracks yet', 'Tap <b>+</b> to import files from your phone, or send audio to your Telegram bot.');
  } else if (state.view.name === 'playlist') {
    const pl = findPlaylist(state.view.id);
    if (!pl) return;
    const rows = [];
    listIds = [];
    pl.trackIds.forEach((id, index) => {
      const t = state.tracks.get(id);
      if (!t) return;
      rows.push(rowHTML(t, listIds.length, index));
      listIds.push(id);
    });
    el.innerHTML = rows.join('') || emptyHTML('Empty playlist', 'Tap <b>Add</b> to put some tracks in.');
  }
  hydrateCovers(el);
}

function updateStatus(id) {
  $$(`[data-status="${id}"]`).forEach((el) => { el.innerHTML = statusIcon(id); });
}

function markPlaying() {
  const cur = player.currentId;
  $$('.row[data-id]').forEach((r) => r.classList.toggle('playing', r.dataset.id === cur));
}

function renderSyncStatus() {
  const btn = $('#syncBtn');
  btn.hidden = !configured();
  btn.classList.toggle('spin', state.syncing);
  btn.classList.toggle('error', !!state.syncError && !state.syncing);
  const el = $('#syncStatus');
  if (!el) return;
  let text;
  if (!configured()) text = 'Not connected — your music only lives on this phone for now.';
  else if (state.syncing) text = 'Syncing…';
  else if (state.syncError) text = `⚠️ ${state.syncError}`;
  else if (state.lastSync) text = `Synced at ${new Date(state.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  else text = 'Connected';
  el.textContent = text;
}

async function refreshStorageInfo() {
  const el = $('#storageInfo');
  if (!el) return;
  const total = state.tracks.size;
  const lim = limitBytes();
  let text = `${state.downloaded.size} of ${plural(total, 'track')} on this phone · ${fmtBytes(downloadedBytes())}${isFinite(lim) ? ` of ${fmtBytes(lim)}` : ''}`;
  el.textContent = text;
}

// ---------- player UI ----------
let seeking = false;
function renderPlayer() {
  const id = player.currentId;
  const t = id && state.tracks.get(id);
  $('#mini').hidden = !t;
  document.body.classList.toggle('has-mini', !!t);
  markPlaying();
  if (!t) { closePlayer(); return; }

  const loading = player.loadingId === id;
  const playIcon = loading ? '<span class="spinner"></span>' : icon(player.playing ? 'pause' : 'play');
  $('#turntable').classList.toggle('playing', player.playing);
  const h = hue(t.id);
  paintArt($('#miniArt'), t);
  paintArt($('#pArt'), t);
  $('#player').style.setProperty('--h', h);
  $('#miniTitle').textContent = $('#pTitle').textContent = t.title;
  $('#miniArtist').textContent = t.artist || (loading ? 'Loading…' : '');
  $('#pArtist').textContent = t.artist || '';
  $('#miniPlay').innerHTML = playIcon;
  $('#pPlay').innerHTML = playIcon;
  $('#pShuffle').classList.toggle('on', player.shuffle);
  $('#pRepeat').classList.toggle('on', player.repeat !== 'off');
  $('#pRepeat').innerHTML = icon(player.repeat === 'one' ? 'repeat-one' : 'repeat');

  const upcoming = player.queue.slice(player.index + 1, player.index + 41);
  $('#upnext').innerHTML = upcoming.length
    ? upcoming.map((qid, i) => {
        const qt = state.tracks.get(qid);
        if (!qt) return '';
        const pos = player.index + 1 + i;
        return `<div class="row" data-action="queue-play" data-pos="${pos}">
          ${art(qt.id, qt.title)}<div class="meta"><div class="t">${esc(qt.title)}</div><div class="s">${esc(qt.artist || fmtTime(qt.duration))}</div></div>
          ${i > 0 ? `<button class="icon-btn more" data-action="queue-up" data-pos="${pos}" aria-label="Move up">${icon('up')}</button>` : ''}
          <button class="icon-btn more" data-action="queue-remove" data-pos="${pos}" aria-label="Remove from queue">${icon('x')}</button>
        </div>`;
      }).join('')
    : '<p class="muted small">Nothing queued.</p>';
  $('#queueClear').hidden = !upcoming.length;
  hydrateCovers($('#upnext'));
  renderTime();
}

function renderTime() {
  const a = player.audio;
  const t = state.tracks.get(player.currentId);
  if (!t) return;
  const silent = player.isSilent;
  const dur = !silent && isFinite(a.duration) ? a.duration : t.duration || 0;
  const cur = silent ? 0 : a.currentTime;
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  $('#miniBar').style.width = `${pct}%`;
  $('#tDur').textContent = fmtTime(dur);
  if (!seeking) {
    const seek = $('#seek');
    seek.value = String(Math.round(pct * 10));
    seek.style.setProperty('--p', `${pct}%`);
    $('#tCur').textContent = fmtTime(cur);
  }
}

function openPlayer() {
  const p = $('#player');
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
}
function closePlayer() {
  const p = $('#player');
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
}

// ---------- sheets (menus, forms, pickers) ----------
let sheetResolve = null;
let sheetGen = 0;
function openSheet(html, resolve) {
  if (sheetResolve) sheetResolve(null);
  sheetResolve = resolve;
  sheetGen++;
  const ov = $('#overlay');
  $('#sheet').innerHTML = html;
  ov.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('open')));
}
function closeSheet(value) {
  const ov = $('#overlay');
  const gen = sheetGen;
  ov.classList.remove('open');
  setTimeout(() => { if (gen === sheetGen) { ov.hidden = true; $('#sheet').innerHTML = ''; } }, 250);
  const r = sheetResolve;
  sheetResolve = null;
  r?.(value);
}

function menu(title, items, subtitle = '') {
  return new Promise((resolve) => {
    openSheet(`
      <div class="sheet-head"><div class="t">${esc(title)}</div>${subtitle ? `<div class="s">${esc(subtitle)}</div>` : ''}</div>
      <div class="menu">${items.map((it) => `<button class="menu-item${it.danger ? ' danger' : ''}" data-key="${esc(it.key)}">${it.icon ? icon(it.icon) : '<span class="ico-space"></span>'}<span>${esc(it.label)}</span></button>`).join('')}</div>
      <button class="menu-cancel" data-key="">Cancel</button>`, resolve);
    $('#sheet').onclick = (e) => {
      const b = e.target.closest('[data-key]');
      if (b) closeSheet(b.dataset.key || null);
    };
  });
}

function form(title, fields, submitLabel = 'Save') {
  return new Promise((resolve) => {
    openSheet(`
      <form class="sheet-form" autocomplete="off">
        <div class="sheet-head"><div class="t">${esc(title)}</div></div>
        ${fields.map((f) => `<label class="field"><span>${esc(f.label)}</span><input name="${f.name}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"></label>`).join('')}
        <div class="sheet-foot"><button type="button" class="pill" data-cancel>Cancel</button><button type="submit" class="pill primary">${esc(submitLabel)}</button></div>
      </form>`, resolve);
    const f = $('#sheet form');
    f.onsubmit = (e) => {
      e.preventDefault();
      closeSheet(Object.fromEntries(new FormData(f)));
    };
    $('#sheet [data-cancel]').onclick = () => closeSheet(null);
    $('#sheet').onclick = null;
    f.querySelector('input')?.focus();
  });
}

function picker(title, tracks) {
  return new Promise((resolve) => {
    openSheet(`
      <div class="sheet-head"><div class="t">${esc(title)}</div></div>
      <div class="pick-list">${tracks.map((t) => `<label class="row pick"><input type="checkbox" value="${t.id}">${art(t.id, t.title)}<div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist || fmtTime(t.duration))}</div></div></label>`).join('')}</div>
      <div class="sheet-foot"><button class="pill" data-cancel>Cancel</button><button class="pill primary" data-done>Add</button></div>`, resolve);
    const sheet = $('#sheet');
    hydrateCovers(sheet);
    sheet.onclick = null;
    const done = sheet.querySelector('[data-done]');
    sheet.onchange = () => {
      const n = sheet.querySelectorAll('input:checked').length;
      done.textContent = n ? `Add ${n}` : 'Add';
    };
    sheet.querySelector('[data-cancel]').onclick = () => closeSheet(null);
    done.onclick = () => closeSheet([...sheet.querySelectorAll('input:checked')].map((i) => i.value));
  });
}

// Search Apple Music + Deezer and let you tap the right cover.
function coverPicker(t) {
  return new Promise((resolve) => {
    const q = [t.artist, t.title].filter(Boolean).join(' ');
    openSheet(`
      <div class="sheet-head"><div class="t">Choose a cover</div><div class="s">Search by artist and song name, then tap the right one.</div></div>
      <form class="cover-search" autocomplete="off">
        <input name="q" type="search" value="${esc(q)}" placeholder="Artist and song">
        <button class="pill primary" type="submit">Search</button>
      </form>
      <div class="cover-grid"></div>
      <div class="sheet-foot"><button class="pill" data-cancel>Cancel</button></div>`, resolve);
    const sheet = $('#sheet');
    const grid = sheet.querySelector('.cover-grid');
    const form = sheet.querySelector('form');
    sheet.onclick = (e) => {
      if (e.target.closest('[data-cancel]')) return closeSheet(null);
      const opt = e.target.closest('[data-url]');
      if (opt) closeSheet(opt.dataset.url);
    };
    const run = async (query) => {
      grid.innerHTML = '<p class="muted small">Searching…</p>';
      try {
        const r = await api.coverOptions(state.settings, t.id, query);
        grid.innerHTML = r.options.length
          ? r.options.map((o) => `<button class="cover-opt" data-url="${esc(o.art)}"><img src="${esc(o.art)}" alt="" loading="lazy"><span class="t">${esc(o.title)}</span><span class="s">${esc(o.artist)}</span></button>`).join('')
          : '<p class="muted small">Nothing found. Try different words.</p>';
      } catch (err) {
        grid.innerHTML = `<p class="muted small">${esc(err.message)}</p>`;
      }
    };
    form.onsubmit = (e) => { e.preventDefault(); form.q.blur(); run(form.q.value.trim()); };
    run(q);
  });
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- actions ----------
async function trackMenu(id, index) {
  const t = state.tracks.get(id);
  if (!t) return;
  const inPlaylist = state.view.name === 'playlist' && index !== '' && index != null;
  const items = [
    { key: 'next', label: 'Play next', icon: 'play-next' },
    { key: 'queue', label: 'Add to queue', icon: 'queue' },
    { key: 'add', label: 'Add to playlist…', icon: 'playlists' },
    { key: 'edit', label: 'Edit title & artist', icon: 'edit' },
  ];
  if (configured() && cloudCopy(id)) {
    items.push({ key: 'cover-pick', label: t.cover ? 'Change cover…' : 'Find cover art…', icon: 'search' });
    if (t.cover) items.push({ key: 'cover-remove', label: 'Remove cover', icon: 'x' });
  }
  if (!state.downloaded.has(id)) items.push({ key: 'download', label: 'Download to phone', icon: 'download' });
  else if (configured() && cloudCopy(id)) items.push({ key: 'undownload', label: 'Remove download', icon: 'x' });
  if (inPlaylist) {
    items.push({ key: 'up', label: 'Move up', icon: 'up' }, { key: 'down', label: 'Move down', icon: 'down' });
    items.push({ key: 'remove', label: 'Remove from playlist', icon: 'x' });
  }
  items.push({ key: 'delete', label: 'Delete track', icon: 'trash', danger: true });

  const key = await menu(t.title, items, t.artist);
  const i = Number(index);
  switch (key) {
    case 'next': player.playNext(id); toast('Playing next'); break;
    case 'queue': player.addToQueue(id); toast('Added to queue'); break;
    case 'add': await addToPlaylist(id); break;
    case 'edit': await editTrack(t); break;
    case 'cover-pick': {
      const url = await coverPicker(t);
      if (!url) break;
      try { applyServerTrack(await api.setCover(state.settings, id, url)); toast('Cover set'); } catch (err) { toast(err.message); }
      break;
    }
    case 'cover-remove':
      try { applyServerTrack(await api.removeCover(state.settings, id)); } catch (err) { toast(err.message); }
      break;
    case 'download': ensureBlob(id).then(() => toast('Downloaded')).catch((e) => toast(e.message)); break;
    case 'undownload':
      await db.del('blobs', id);
      state.downloaded.delete(id);
      updateStatus(id);
      break;
    case 'up':
    case 'down': {
      const pl = findPlaylist(state.view.id);
      const j = key === 'up' ? i - 1 : i + 1;
      if (!pl || j < 0 || j >= pl.trackIds.length) break;
      changePlaylists(() => { [pl.trackIds[i], pl.trackIds[j]] = [pl.trackIds[j], pl.trackIds[i]]; });
      renderList();
      break;
    }
    case 'remove': {
      const pl = findPlaylist(state.view.id);
      if (!pl) break;
      changePlaylists(() => pl.trackIds.splice(i, 1));
      renderView();
      break;
    }
    case 'delete': await deleteTrack(t); break;
  }
}

async function editTrack(t) {
  const v = await form('Edit track', [
    { name: 'title', label: 'Title', value: t.title },
    { name: 'artist', label: 'Artist', value: t.artist, placeholder: 'Optional' },
  ]);
  if (!v) return;
  t.title = v.title.trim() || t.title;
  t.artist = v.artist.trim();
  await db.put('tracks', t);
  if (!isPendingUpload(t.id) && !state.pending.renames.includes(t.id)) state.pending.renames.push(t.id);
  await savePending();
  renderView();
  renderPlayer();
  if (player.currentId === t.id) player.updateMetadata();
  scheduleSync();
}

async function deleteTrack(t) {
  if (!confirm(`Delete “${t.title}”?${configured() ? ' It will be removed from all your devices.' : ''}`)) return;
  const p = state.pending;
  if (isPendingUpload(t.id)) p.uploads = p.uploads.filter((x) => x !== t.id);
  else p.deletes.push(t.id);
  p.renames = p.renames.filter((x) => x !== t.id);
  await savePending();
  await removeTrackLocally(t.id);
  if (state.playlists.items.some((pl) => pl.trackIds.includes(t.id))) {
    changePlaylists((items) => items.forEach((pl) => { pl.trackIds = pl.trackIds.filter((x) => x !== t.id); }));
  }
  renderView();
  scheduleSync();
}

async function createPlaylist() {
  const v = await form('New playlist', [{ name: 'name', label: 'Name', placeholder: 'e.g. Demos' }], 'Create');
  const name = v?.name?.trim();
  if (!name) return null;
  const pl = { id: uid(), name, trackIds: [], createdAt: Date.now() };
  changePlaylists((items) => items.push(pl));
  return pl;
}

async function addToPlaylist(id) {
  const items = [{ key: '__new', label: 'New playlist…', icon: 'plus' }, ...state.playlists.items.map((p) => ({ key: p.id, label: p.name, icon: 'playlists' }))];
  const key = await menu('Add to playlist', items);
  if (!key) return;
  const pl = key === '__new' ? await createPlaylist() : findPlaylist(key);
  if (!pl) return;
  if (pl.trackIds.includes(id)) return toast(`Already in ${pl.name}`);
  changePlaylists(() => pl.trackIds.push(id));
  toast(`Added to ${pl.name}`);
  if (state.view.name !== 'library') renderView();
}

async function addSongs(pl) {
  const options = [...state.tracks.values()].filter((t) => !pl.trackIds.includes(t.id)).sort(newestFirst);
  if (!options.length) return toast(state.tracks.size ? 'Every track is already in here' : 'Import some tracks first');
  const ids = await picker(`Add to ${pl.name}`, options);
  if (!ids?.length) return;
  changePlaylists(() => pl.trackIds.push(...ids));
  toast(`Added ${plural(ids.length, 'track')}`);
  renderView();
}

async function playlistMenu(pl) {
  const key = await menu(pl.name, [
    { key: 'rename', label: 'Rename', icon: 'edit' },
    { key: 'delete', label: 'Delete playlist', icon: 'trash', danger: true },
  ]);
  if (key === 'rename') {
    const v = await form('Rename playlist', [{ name: 'name', label: 'Name', value: pl.name }]);
    if (!v?.name?.trim()) return;
    changePlaylists(() => { pl.name = v.name.trim(); });
    renderView();
  } else if (key === 'delete') {
    if (!confirm(`Delete the playlist “${pl.name}”? Your tracks stay in the library.`)) return;
    changePlaylists((items) => items.splice(items.indexOf(pl), 1));
    state.view = { name: 'playlists' };
    renderView();
  }
}

async function saveServer() {
  let url = $('#serverUrl').value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  state.settings.serverUrl = url.replace(/\/+$/, '');
  state.settings.token = $('#token').value.trim();
  state.syncError = '';
  await saveSettings();
  renderView();
  renderSyncStatus();
  if (configured()) await sync(true);
  renderView();
  renderSyncStatus();
}

async function connectTelegram() {
  try {
    toast('Connecting…');
    const r = await api.connectTelegram(state.settings);
    const key = await menu(`Bot ready: @${r.bot}`, [{ key: 'open', label: 'Open Telegram to finish', icon: 'telegram' }],
      'Tap below, then press Start in Telegram. The link works for 30 minutes.');
    if (key === 'open') window.location.href = r.link;
  } catch (err) {
    toast(err.message);
  }
}

async function removeDownloads() {
  const removable = [...state.downloaded].filter((id) => cloudCopy(id) && id !== player.currentId);
  if (!removable.length) return toast('Nothing to remove');
  if (!confirm(`Remove ${plural(removable.length, 'downloaded track')} from this phone? They stay in the cloud and download again when you play them.`)) return;
  for (const id of removable) {
    await db.del('blobs', id);
    state.downloaded.delete(id);
  }
  if (state.settings.autoDownload) {
    state.settings.autoDownload = false;
    await saveSettings();
  }
  toast('Space freed · auto-download turned off');
  renderView();
}

// ---------- events ----------
function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled || el.closest('#sheet')) return;
    const a = el.dataset.action;
    switch (a) {
      case 'tab':
        state.view = { name: el.dataset.tab };
        renderView();
        $('#view').scrollTop = 0;
        break;
      case 'play-row': player.playList(listIds, Number(el.dataset.pos), { context: currentContext() }); break;
      case 'play-list': if (listIds.length) player.playList(listIds, 0, { shuffle: false, context: currentContext() }); break;
      case 'shuffle-list': if (listIds.length) player.playList(listIds, Math.floor(Math.random() * listIds.length), { shuffle: true, context: currentContext() }); break;
      case 'lib-tab':
        state.libTab = el.dataset.lib;
        state.search = '';
        renderView();
        break;
      case 'open-artist':
        state.view = { name: 'artist', key: el.dataset.key };
        renderView();
        $('#view').scrollTop = 0;
        break;
      case 'back-artists':
        state.view = { name: 'library' };
        state.libTab = 'artists';
        renderView();
        break;
      case 'open-recent': {
        const { type, id } = el.dataset;
        if (type === 'track') {
          const ids = libraryTracks().map((t) => t.id);
          const at = ids.indexOf(id);
          player.playList(at >= 0 ? ids : [id], Math.max(0, at));
        } else if (type === 'playlist') {
          state.view = { name: 'playlist', id };
          renderView();
        } else if (type === 'artist') {
          state.view = { name: 'artist', key: id };
          renderView();
        }
        $('#view').scrollTop = 0;
        break;
      }
      case 'queue-up': player.moveUp(Number(el.dataset.pos)); break;
      case 'queue-remove': player.removeAt(Number(el.dataset.pos)); break;
      case 'queue-clear': player.clearUpcoming(); break;
      case 'track-menu': trackMenu(el.dataset.id, el.dataset.index); break;
      case 'open-playlist':
        state.view = { name: 'playlist', id: el.dataset.id };
        renderView();
        $('#view').scrollTop = 0;
        break;
      case 'new-playlist':
        createPlaylist().then((pl) => { if (pl) { state.view = { name: 'playlist', id: pl.id }; renderView(); } });
        break;
      case 'add-songs': { const pl = findPlaylist(state.view.id); if (pl) addSongs(pl); break; }
      case 'playlist-menu': { const pl = findPlaylist(state.view.id); if (pl) playlistMenu(pl); break; }
      case 'sort':
        state.settings.sort = state.settings.sort === 'az' ? 'new' : 'az';
        saveSettings();
        renderView();
        break;
      case 'import': $('#fileInput').click(); break;
      case 'sync': sync(true); break;
      case 'save-server': saveServer(); break;
      case 'connect-telegram': connectTelegram(); break;
      case 'download-all': toast('Downloading…'); backgroundDownload(true); break;
      case 'remove-downloads': removeDownloads(); break;
      case 'find-covers': findMissingCovers(); break;
      case 'open-player': openPlayer(); break;
      case 'close-player': closePlayer(); break;
      case 'toggle': player.toggle(); break;
      case 'next': player.next(); break;
      case 'prev': player.prev(); break;
      case 'shuffle': player.setShuffle(!player.shuffle); break;
      case 'repeat': player.cycleRepeat(); break;
      case 'current-menu': if (player.currentId) trackMenu(player.currentId, ''); break;
      case 'queue-play': player.load(Number(el.dataset.pos)); break;
    }
  });

  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeSheet(null); });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') { state.search = e.target.value; renderList(); }
    if (e.target.id === 'seek') {
      seeking = true;
      const pct = Number(e.target.value) / 10;
      e.target.style.setProperty('--p', `${pct}%`);
      const t = state.tracks.get(player.currentId);
      const dur = isFinite(player.audio.duration) ? player.audio.duration : t?.duration || 0;
      $('#tCur').textContent = fmtTime((pct / 100) * dur);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'seek') {
      const dur = player.audio.duration;
      if (isFinite(dur)) player.seek((Number(e.target.value) / 1000) * dur);
      seeking = false;
    }
    if (e.target.id === 'storageLimit') {
      state.settings.storageLimitMB = Number(e.target.value);
      saveSettings();
      enforceStorageLimit().then(() => { if (state.settings.autoDownload) backgroundDownload(); });
    }
    if (e.target.id === 'autoDownload') {
      state.settings.autoDownload = e.target.checked;
      saveSettings();
      if (e.target.checked) backgroundDownload();
    }
    if (e.target.id === 'fileInput') {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) importFiles(files);
    }
  });

  // Swipe down on the full player to close it.
  let startY = null;
  const top = $('#player');
  top.addEventListener('touchstart', (e) => { startY = top.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  top.addEventListener('touchend', (e) => {
    if (startY != null && e.changedTouches[0].clientY - startY > 90) closePlayer();
    startY = null;
  });

  player.addEventListener('change', renderPlayer);
  player.audio.addEventListener('timeupdate', renderTime);
  player.audio.addEventListener('durationchange', renderTime);
  player.audio.addEventListener('playing', () => {
    if (player.isSilent || !player.currentId) return;
    markPlayed(player.currentId);
    addRecent(player.context || { type: 'track', id: player.currentId });
  });

  // Remember what was playing (song, position, queue) so the app picks up where you left off.
  let saveTimer;
  const savePlayer = () => db.put('kv', player.snapshot(), 'playerState');
  player.addEventListener('change', () => { clearTimeout(saveTimer); saveTimer = setTimeout(savePlayer, 400); });
  let lastPosSave = 0;
  player.audio.addEventListener('timeupdate', () => {
    if (Date.now() - lastPosSave > 5000 && !player.isSilent) { lastPosSave = Date.now(); savePlayer(); }
  });
  player.audio.addEventListener('pause', savePlayer);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayer(); });
  window.addEventListener('pagehide', savePlayer);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  window.addEventListener('online', () => sync());
}

// The app moved to its own address so iOS doesn't mix it up with other web
// apps on github.io (e.g. the lock screen opening the wrong app).
const HOME_URL = 'https://selftape.selftape-api.workers.dev/';
function showMovedNotice() {
  if (!location.hostname.endsWith('github.io')) return;
  const el = document.createElement('div');
  el.className = 'moved';
  el.innerHTML = `<b>Selftape has a new address</b>
    <span>Open the link below in Safari, tap Share → Add to Home Screen, then delete this old icon. Your music and playlists come back after you sign in again in Settings.</span>
    <a class="pill primary" href="${HOME_URL}">Open new Selftape</a>`;
  document.body.appendChild(el);
}

// ---------- start ----------
async function init() {
  $$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon) + el.innerHTML; });

  const [tracks, blobKeys, playlists, settings, pending, recent, playerState] = await Promise.all([
    db.all('tracks'), db.keys('blobs'), db.get('kv', 'playlists'), db.get('kv', 'settings'), db.get('kv', 'pending'),
    db.get('kv', 'recent'), db.get('kv', 'playerState'),
  ]);
  if (Array.isArray(recent)) state.recent = recent;
  tracks.forEach((t) => state.tracks.set(t.id, t));
  state.downloaded = new Set(blobKeys);
  if (playlists) state.playlists = playlists;
  if (settings) Object.assign(state.settings, settings);
  if (pending) Object.assign(state.pending, pending);

  player.init({
    getBlob: ensureBlob,
    getTrack: (id) => state.tracks.get(id),
    getArtwork: (id) => lockScreenArtwork(id),
    onError: (err) => toast(err.message || "Couldn't play that track"),
    onDuration: (id, d) => {
      const t = state.tracks.get(id);
      if (t && !t.duration) { t.duration = d; db.put('tracks', t); }
    },
  });

  bindEvents();
  render();
  showMovedNotice();

  // Pick up where you left off (paused, at the same second).
  if (playerState?.queue) {
    const known = playerState.queue.every((id) => state.tracks.has(id));
    if (known) player.restore(playerState);
  }

  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  sync();
}

init();
