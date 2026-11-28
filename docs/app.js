import { db } from './db.js';
import * as api from './api.js';
import { player } from './player.js';
import { icon } from './icons.js';

const APP_VERSION = 'v29'; // keep in sync with VERSION in sw.js

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
  pending: { uploads: [], deletes: [], renames: [], playlistsDirty: false, plays: [], recentDirty: false },
  view: { name: 'library' },
  search: '',
  libTab: 'songs', // songs | artists
  recent: [],      // [{ type: 'track'|'playlist'|'artist', id, at }]
  artistPhotos: {}, // artist key -> photo url ('' = checked, no photo)
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
  $$('[data-artist]', root).forEach((el) => {
    const key = el.dataset.artist;
    const name = el.dataset.name;
    el.removeAttribute('data-artist');
    loadArtistPhoto(key, name).then((url) => {
      if (!url || !el.isConnected) return;
      el.classList.add('has-img');
      el.style.backgroundImage = `url('${url}')`;
      el.textContent = '';
    });
  });
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

// A play counts once you've listened for 30 seconds (for "On repeat").
function countPlay(id) {
  const t = state.tracks.get(id);
  if (!t) return;
  const at = Date.now();
  t.plays = [...(t.plays || []), at].slice(-30);
  db.put('tracks', t);
  state.pending.plays = [...(state.pending.plays || []), { id, at }].slice(-500);
  savePending();
  scheduleHistoryPush();
}

// Send plays + "recently played" to the server (shared with your other devices).
let historyTimer;
function scheduleHistoryPush() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(pushHistory, 4000);
}
async function pushHistory() {
  const p = state.pending;
  if (!configured() || !navigator.onLine || (!p.plays?.length && !p.recentDirty)) return;
  const plays = (p.plays || []).slice();
  try {
    const r = await api.postHistory(state.settings, { plays, recent: p.recentDirty ? state.recent : [] });
    p.plays = (p.plays || []).slice(plays.length);
    p.recentDirty = false;
    await savePending();
    if (Array.isArray(r.recent)) applyServerRecent(r.recent);
    if (r.nowPlaying) applyServerNowPlaying(r.nowPlaying);
  } catch {}
}

// ---------- where you left off, shared between devices ----------
// The newest device to actually play something wins; the others pick it up
// (paused, at the same second) next time they're opened, unless they're playing.
const np = { device: '', at: 0, sig: '', pushedAt: 0, lastPush: 0 };
const npSig = (s) => (s ? `${s.index}|${s.shuffle}|${s.repeat}|${s.queue.join(',')}` : '');

function nowPlayingSnapshot() {
  const s = player.snapshot();
  if (!s) return null;
  const sig = npSig(s);
  if (sig !== np.sig || player.playing) { np.sig = sig; np.at = Date.now(); }
  return { ...s, at: np.at, device: np.device };
}

async function pushNowPlaying(snap, urgent = false) {
  if (!snap || !configured() || !navigator.onLine || snap.at <= np.pushedAt) return;
  if (!urgent && Date.now() - np.lastPush < 30000) return;
  np.lastPush = Date.now();
  try {
    await api.postHistory(state.settings, { plays: [], recent: [], nowPlaying: snap }, urgent);
    np.pushedAt = Math.max(np.pushedAt, snap.at);
  } catch {}
}

function applyServerNowPlaying(remote) {
  if (!remote?.queue?.length || remote.device === np.device || remote.at <= np.at) return;
  if (player.playing) return; // don't interrupt what you're listening to here
  if (!remote.queue.every((id) => state.tracks.has(id))) return;
  np.at = remote.at;
  np.pushedAt = remote.at;
  np.sig = npSig(remote);
  const had = player.currentId != null;
  player.restore(remote);
  db.put('kv', { ...remote, device: np.device }, 'playerState');
  if (had || remote.time > 5) toast('Picked up where you left off on your other device');
}

// Merge another device's "recently played" into ours (newest first, no duplicates).
function applyServerRecent(list) {
  const seen = new Set();
  const merged = [...state.recent, ...list]
    .sort((a, b) => b.at - a.at)
    .filter((r) => { const k = `${r.type}:${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 12);
  if (JSON.stringify(merged) === JSON.stringify(state.recent)) return;
  state.recent = merged;
  db.put('kv', state.recent, 'recent');
  renderRecent();
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
  analyzeLibrary();
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
    await pushHistory();
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
      const merged = { ...lt, ...st, duration: st.duration || lt?.duration || 0, features: st.features || lt?.features || null };
      if (!lt || lt.title !== merged.title || lt.artist !== merged.artist || lt.duration !== merged.duration || lt.size !== merged.size
        || lt.cover !== merged.cover || (lt.genre || '') !== (merged.genre || '') || !!lt.features !== !!merged.features) {
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
    // plays from all devices -> On repeat, After dark, Forgotten gems
    if (lib.plays) {
      for (const [id, list] of Object.entries(lib.plays)) {
        const t = state.tracks.get(id);
        if (!t) continue;
        const merged = [...new Set([...(t.plays || []), ...list])].sort((a, b) => a - b).slice(-30);
        const last = Math.max(t.lastPlayed || 0, merged[merged.length - 1] || 0);
        if (merged.length !== (t.plays || []).length || last !== (t.lastPlayed || 0)) {
          t.plays = merged;
          t.lastPlayed = last;
          await db.put('tracks', t);
        }
      }
    }
    if (Array.isArray(lib.recent)) applyServerRecent(lib.recent);
    if (lib.nowPlaying) applyServerNowPlaying(lib.nowPlaying);
    if (lib.artistPhotos && JSON.stringify(lib.artistPhotos) !== JSON.stringify(state.artistPhotos)) {
      state.artistPhotos = lib.artistPhotos;
      db.put('kv', state.artistPhotos, 'artistPhotos');
      if (state.view.name === 'artist' || state.libTab === 'artists') changed = true;
    }
    if (uploadProblem) state.syncError = uploadProblem;
    if (changed) renderView();
    if (s.autoDownload) backgroundDownload().then(analyzeLibrary);
    else analyzeLibrary();
    fillGenres();
    loadDiscover();
    loadInspo();
    loadMoodLists();
    setTimeout(fillLyrics, 20000);
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
  const active = state.view.name === 'playlist' ? 'playlists' : ['artist', 'mix'].includes(state.view.name) ? 'library' : state.view.name;
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
  } else if (v.name === 'mix') {
    const mix = findMix(v.id);
    if (!mix) { state.view = { name: 'library' }; return renderView(); }
    $('#pageTitle').textContent = 'Library';
    el.innerHTML = mixHTML(mix);
    hydrateCovers(el);
    renderList();
  } else if (v.name === 'discover') {
    $('#pageTitle').textContent = 'Discover';
    el.innerHTML = discoverHTML();
    if (!state.discover?.groups?.length) loadDiscover();
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
    <div id="mixes"></div>
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

// Groups songs by artist. Spellings that are clearly the same person
// ("Afshin Moghadam" / "Afshin Moghaddam", "Guns N Roses" / "Guns N' Roses")
// are shown as one artist, using the spelling found on the most songs.
function artistIndex() {
  // 1) count every spelling
  const spellings = new Map(); // exact key -> { name, ids }
  for (const t of [...state.tracks.values()].sort(newestFirst)) {
    for (const name of splitArtists(t.artist)) {
      const key = artistKey(name);
      if (!spellings.has(key)) spellings.set(key, { name, ids: [] });
      spellings.get(key).ids.push(t.id);
    }
  }
  // 2) merge near-identical spellings, most common first
  const groups = [];
  for (const [key, sp] of [...spellings].sort((a, b) => b[1].ids.length - a[1].ids.length)) {
    const g = groups.find((x) => sameArtist(x.key, key));
    if (g) {
      g.variants.add(sp.name);
      for (const id of sp.ids) if (!g.ids.includes(id)) g.ids.push(id);
    } else {
      groups.push({ key, name: sp.name, ids: sp.ids.slice(), variants: new Set([sp.name]) });
    }
  }
  return new Map(groups.map((g) => [g.key, g]));
}

// Same artist, spelled slightly differently? Only for longer names, so short
// different names ("Drake" / "Drak") stay apart.
function sameArtist(a, b) {
  if (a === b) return true;
  const flat = (x) => x.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/\b(the|and|n)\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  const fa = flat(a);
  const fb = flat(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  const squash = (x) => x.replace(/(.)\1+/g, '$1'); // "moghaddam" -> "moghadam"
  if (fa.length >= 5 && squash(fa) === squash(fb)) return true;
  return Math.min(fa.length, fb.length) >= 8 && textSimilarity(fa, fb) >= 0.9;
}

function textSimilarity(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

const artistCoverId = (a) => a.ids.find((id) => state.tracks.get(id)?.cover) || a.ids[0];

// Artist picture: their photo (from Deezer) when there is one, else a song cover.
const artistUrls = new Map(); // key -> { ver, url }
const artistJobs = new Map();
function artistArt(a, cls = '') {
  const ver = state.artistPhotos[a.key];
  if (!ver) return art(a.key, a.name, `round ${cls}`, artistCoverId(a));
  const ready = artistUrls.get(a.key);
  if (ready && ready.ver === ver) return `<div class="art round has-img ${cls}" style="--h:${hue(a.key)};background-image:url('${ready.url}')"></div>`;
  return `<div class="art round ${cls}" style="--h:${hue(a.key)}" data-artist="${esc(a.key)}" data-name="${esc(a.name)}">${esc(initial(a.name))}</div>`;
}

function loadArtistPhoto(key, name) {
  const ver = state.artistPhotos[key];
  if (!ver) return Promise.resolve(null);
  const ready = artistUrls.get(key);
  if (ready && ready.ver === ver) return Promise.resolve(ready.url);
  if (artistJobs.has(key)) return artistJobs.get(key);
  const job = (async () => {
    let rec = await db.get('kv', `aphoto:${key}`);
    if (!rec || rec.ver !== ver) {
      if (!configured() || !navigator.onLine) return null;
      const blob = await limited(() => api.getArtistPhoto(state.settings, name)).catch(() => null);
      if (!blob) return null;
      rec = { ver, blob };
      await db.put('kv', rec, `aphoto:${key}`);
    }
    const old = artistUrls.get(key);
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(rec.blob);
    artistUrls.set(key, { ver, url });
    return url;
  })().finally(() => artistJobs.delete(key));
  artistJobs.set(key, job);
  return job;
}

// Ask the server about artists it hasn't checked yet (a few at a time).
let artistLookupBusy = false;
async function checkArtistPhotos(artists) {
  if (artistLookupBusy || !configured() || !navigator.onLine) return;
  const todo = artists.filter((a) => !(a.key in state.artistPhotos));
  if (!todo.length) return;
  artistLookupBusy = true;
  try {
    for (let i = 0; i < todo.length; i += 8) {
      const batch = todo.slice(i, i + 8).map((a) => ({
        name: a.name,
        titles: a.ids.map((id) => state.tracks.get(id)?.title).filter(Boolean).slice(0, 8),
      }));
      const r = await api.findArtistPhotos(state.settings, batch);
      Object.assign(state.artistPhotos, r.photos);
      // mark ones the server skipped so we don't ask again this session
      for (const b of batch) { const k = artistKey(b.name); if (!(k in state.artistPhotos)) state.artistPhotos[k] = ''; }
      db.put('kv', state.artistPhotos, 'artistPhotos');
      if (Object.values(r.photos).some(Boolean) && (state.view.name === 'library' || state.view.name === 'artist')) renderList();
    }
  } catch {} finally {
    artistLookupBusy = false;
  }
}

async function artistMenu(a) {
  const has = !!state.artistPhotos[a.key];
  const others = [...a.variants].filter((v) => v !== a.name);
  const key = await menu(a.name, [
    { key: 'rename', label: 'Rename artist…', icon: 'edit' },
    ...(configured() ? [{ key: 'pick', label: has ? 'Change photo…' : 'Choose photo…', icon: 'search' }] : []),
    ...(configured() && has ? [{ key: 'none', label: 'Use a song cover instead', icon: 'x' }] : []),
  ], others.length ? `Also spelled: ${others.join(', ')}` : '');
  if (!key) return;
  if (key === 'rename') return renameArtist(a);
  const url = key === 'pick'
    ? await imagePicker({ title: 'Choose a photo', hint: 'Search for the artist, then tap the right photo.', query: a.name, round: true,
        search: (q) => api.artistPhotoOptions(state.settings, q) })
    : '';
  if (key === 'pick' && !url) return;
  try {
    await api.setArtistPhoto(state.settings, a.name, url);
    state.artistPhotos[a.key] = url;
    db.put('kv', state.artistPhotos, 'artistPhotos');
    renderView();
  } catch (err) { toast(err.message); }
}

// Rename an artist on all their songs (also merges the different spellings).
async function renameArtist(a) {
  const v = await form('Rename artist', [{ name: 'name', label: `New name for all ${plural(a.ids.length, 'song')}`, value: a.name }], 'Rename');
  const name = v?.name?.trim();
  if (!name) return;
  const variants = [...a.variants].sort((x, y) => y.length - x.length);
  const esc2 = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const id of a.ids) {
    const t = state.tracks.get(id);
    if (!t) continue;
    let artist = t.artist || '';
    for (const old of variants) artist = artist.replace(new RegExp(esc2(old), 'ig'), name);
    if (artist === t.artist) continue;
    t.artist = artist;
    await db.put('tracks', t);
    if (!isPendingUpload(t.id) && !state.pending.renames.includes(t.id)) state.pending.renames.push(t.id);
  }
  await savePending();
  toast(`Renamed to “${name}”`);
  state.view = { name: 'artist', key: artistKey(name) };
  renderView();
  renderPlayer();
  scheduleSync();
}

function artistHTML(a) {
  const ts = a.ids.map((id) => state.tracks.get(id)).filter(Boolean);
  const total = ts.reduce((s, t) => s + (t.duration || 0), 0);
  return `
    <button class="back" data-action="back-artists">${icon('chevron-left')} Artists</button>
    <div class="pl-head">
      ${artistArt(a, 'big')}
      <div class="meta"><h2>${esc(a.name)}</h2><div class="muted small">${plural(ts.length, 'track')}${total ? ` · ${fmtTotal(total)}` : ''}</div></div>
    </div>
    <div class="actions-row">
      <button class="pill primary" data-action="play-list">${icon('play')} Play</button>
      <button class="pill" data-action="shuffle-list">${icon('shuffle')} Shuffle</button>
      <span class="grow"></span>
      <button class="icon-btn more" data-action="artist-menu" aria-label="Artist options">${icon('more')}</button>
    </div>
    <div id="list" class="list"></div>`;
}

// ---------- genres ----------
function knownGenres() {
  return [...new Set([...state.tracks.values()].map((t) => (t.genre || '').trim()).filter(Boolean))].sort();
}

// Group similar genre names ("Hard Rock" + "Rock", "Hip-Hop/Rap" + "Rap") into one mix.
function genreFamily(g) {
  const s = String(g || '').toLowerCase();
  if (!s) return '';
  if (/metal|core\b|metalcore|deathcore/.test(s)) return 'Metal';
  if (/hip.?hop|rap|trap|drill/.test(s)) return 'Hip-Hop';
  if (/r&b|rnb|soul|funk/.test(s)) return 'R&B';
  if (/electro|dance|house|techno|edm|trance|dubstep|drum.?n|dnb/.test(s)) return 'Electronic';
  if (/punk/.test(s)) return 'Punk';
  if (/rock|grunge|alternative|indie/.test(s)) return 'Rock';
  if (/lo.?fi|chill|ambient/.test(s)) return 'Chill';
  if (/jazz|blues/.test(s)) return 'Jazz';
  if (/classical|piano|orchestra|soundtrack/.test(s)) return 'Classical';
  if (/singer|songwriter|acoustic|folk/.test(s)) return 'Acoustic';
  if (/pop/.test(s)) return 'Pop';
  return g.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Ask the server to fill in genres for older songs (once per app start, in the background).
let genresFilled = false;
async function fillGenres() {
  if (genresFilled || !configured() || !navigator.onLine) return;
  genresFilled = true;
  try {
    let found = 0;
    for (let i = 0; i < 100; i++) {
      const r = await api.findMissingGenres(state.settings);
      found += r.found;
      if (!r.remaining || !r.checked || r.retry >= r.checked) break; // nothing more to do right now
    }
    if (found) scheduleSync(500);
  } catch {}
}

// ---------- listening to the songs (tempo, energy) ----------
// Runs in the background on songs that are on this device; the result is
// shared through the server so other devices don't need to redo it.
const ANALYSIS_VERSION = 2; // 2 = adds musical key (major/minor)
let analyzing = false;
async function analyzeLibrary() {
  if (analyzing) return;
  analyzing = true;
  let did = 0;
  try {
    for (const t of [...state.tracks.values()]) {
      if (t.features?.v === ANALYSIS_VERSION || !state.downloaded.has(t.id)) continue;
      if (document.hidden) await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
      const blob = await db.get('blobs', t.id);
      if (!blob) continue;
      const features = await analyzeAudio(blob).catch(() => null);
      if (!features) { t.features = { v: ANALYSIS_VERSION, failed: true }; await db.put('tracks', t); continue; }
      t.features = features;
      await db.put('tracks', t);
      did++;
      if (configured() && cloudCopy(t.id)) api.saveFeatures(state.settings, t.id, features).catch(() => {});
      await new Promise((r) => setTimeout(r, 300)); // stay light
      if (did % 5 === 0) renderMixes();
    }
  } finally {
    analyzing = false;
    if (did) renderMixes();
  }
}

async function analyzeAudio(blob) {
  const SR = 11025;
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, SR, SR);
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  // mono mix of up to 2 minutes from the middle of the song
  const total = audio.length;
  const len = Math.min(total, SR * 120);
  const start = Math.max(0, Math.floor((total - len) / 2));
  const x = new Float32Array(len);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) x[i] += d[start + i] / audio.numberOfChannels;
  }
  // loudness, brightness (zero crossings), per-frame energy
  const F = 256;
  const frames = Math.floor(len / F);
  if (frames < 200) return null;
  const e = new Float32Array(frames);
  let sum = 0;
  let zc = 0;
  for (let f = 0; f < frames; f++) {
    let fe = 0;
    for (let i = f * F; i < (f + 1) * F; i++) {
      fe += x[i] * x[i];
      if (i && (x[i] >= 0) !== (x[i - 1] >= 0)) zc++;
    }
    e[f] = Math.sqrt(fe / F);
    sum += fe;
  }
  const rms = Math.sqrt(sum / (frames * F));
  const energy = 20 * Math.log10(rms + 1e-9);
  const zcr = zc / (frames * F);
  const mean = e.reduce((a, b) => a + b, 0) / frames;
  const dyn = Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / frames) / (mean + 1e-9);
  // tempo: autocorrelation of the onset strength (rises in energy)
  const o = new Float32Array(frames);
  for (let f = 1; f < frames; f++) o[f] = Math.max(0, e[f] - e[f - 1]);
  const fps = SR / F;
  let best = 0;
  let bestBpm = 0;
  for (let bpm = 70; bpm <= 180; bpm++) {
    const lag = (60 * fps) / bpm;
    const l0 = Math.floor(lag);
    const fr = lag - l0;
    let c = 0;
    for (let f = l0 + 1; f < frames; f++) c += o[f] * (o[f - l0] * (1 - fr) + o[f - l0 - 1] * fr);
    const weight = Math.exp(-0.5 * ((bpm - 120) / 40) ** 2); // gently prefer common tempos
    if (c * weight > best) { best = c * weight; bestBpm = bpm; }
  }
  const key = detectKey(x, SR);
  return { v: ANALYSIS_VERSION, energy: +energy.toFixed(2), tempo: bestBpm, zcr: +zcr.toFixed(4), dyn: +dyn.toFixed(3), ...key };
}

// Which notes the song uses most (a "chromagram"), compared with the classic
// Krumhansl key profiles -> key, major/minor, and how sure it is (0..1).
function detectKey(x, SR) {
  const N = 4096;
  const chroma = new Float64Array(12);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const lo = Math.ceil((55 * N) / SR);
  const hi = Math.floor((2000 * N) / SR);
  const pc = new Int8Array(hi + 1);
  for (let k = lo; k <= hi; k++) pc[k] = (((Math.round(12 * Math.log2((k * SR) / N / 440)) + 9) % 12) + 12) % 12;
  for (let start = 0; start + N <= x.length; start += N) {
    for (let i = 0; i < N; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = lo; k <= hi; k++) chroma[pc[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (a, b) => {
    const ma = a.reduce((s, v) => s + v, 0) / 12;
    const mb = b.reduce((s, v) => s + v, 0) / 12;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db || 1);
  };
  let best = { r: -2 };
  let bestMaj = -2;
  let bestMin = -2;
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12]);
    const rMaj = corr(rot, MAJOR);
    const rMin = corr(rot, MINOR);
    bestMaj = Math.max(bestMaj, rMaj);
    bestMin = Math.max(bestMin, rMin);
    if (rMaj > best.r) best = { r: rMaj, tonic, mode: 'major' };
    if (rMin > best.r) best = { r: rMin, tonic, mode: 'minor' };
  }
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return {
    key: `${NAMES[best.tonic ?? 0]} ${best.mode || 'major'}`,
    mode: best.mode === 'minor' ? -1 : 1,
    modeConf: +Math.min(1, Math.abs(bestMaj - bestMin) * 4).toFixed(2), // how clearly major vs minor
  };
}

// In-place radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// ---------- "Made for you" mixes ----------
// Rebuilt from your library every day; nothing is saved unless you tap Save.

function seeded(seedText) {
  let h = 1779033703;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 3432918353), h = (h << 13) | (h >>> 19);
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
function shuffleWith(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const today = () => new Date().toISOString().slice(0, 10);

let mixCache = { key: '', mixes: [] };
function computeMixes() {
  const all = [...state.tracks.values()];
  const key = `${today()}|${state.inspo?.day || ''}|${state.moodLists?.at || 0}|${state.inspo?.playlists?.length || 0}|${Math.floor(new Date().getHours() / 2)}|${all.length}|${all.filter((t) => t.features && !t.features.failed).length}|${all.reduce((n, t) => n + (t.plays?.length || 0), 0)}|${all.map((t) => t.genre || '').join(',').length}`;
  if (mixCache.key.startsWith(key + '|')) return mixCache.mixes;
  const day = today();
  const mixes = [];
  const add = (id, name, desc, ids, hueVal, min = 5) => {
    if (ids.length >= min) mixes.push({ id, name, desc, ids: ids.slice(0, 30), hue: hueVal });
  };
  const now = Date.now();
  const MONTH = 30 * 86400e3;

  // On repeat: most played in the last 30 days
  const repeat = all
    .map((t) => ({ t, n: (t.plays || []).filter((p) => now - p < MONTH).length }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.t.id);
  add('repeat', 'On repeat', 'What you can’t stop playing lately', repeat, 280);

  // Recently added
  add('new', 'Recently added', 'Fresh in your library', all.filter((t) => now - t.addedAt < MONTH).sort(newestFirst).map((t) => t.id), 150, 4);

  // Mood mixes: built from what the app hears in each song (compared within
  // your own library), its genre, and when you usually play it.
  const hour = new Date().getHours();
  const analyzed = all.filter((t) => t.features && !t.features.failed);
  const timeFirst = new Set(); // mixes that fit the current time of day go first
  if (analyzed.length >= 8 || state.moodLists) {
    const pct = (field) => {
      const sorted = analyzed.map((t) => t.features[field]).sort((a, b) => a - b);
      return (v) => sorted.findIndex((x) => x >= v) / Math.max(1, sorted.length - 1);
    };
    const eP = pct('energy');
    const zP = pct('zcr');
    const dP = pct('dyn');
    const tP = pct('tempo');
    const between = (v, a, b) => (v >= a && v <= b ? 1 : 0);
    const nightShare = (t) => {
      const p = t.plays || [];
      return p.length ? p.filter((x) => { const h = new Date(x).getHours(); return h >= 22 || h < 4; }).length / p.length : 0;
    };
    const rows = analyzed.map((t) => {
      const f = t.features;
      const fam = genreFamily(t.genre);
      const g = (...names) => (names.includes(fam) ? 1 : 0);
      const mode = (f.mode ?? 0) * (f.modeConf ?? 0); // +1 clearly major ... -1 clearly minor
      return {
        t, f, fam, g, mode,
        energy: eP(f.energy), bright: zP(f.zcr), steady: 1 - dP(f.dyn), tempoRank: tP(f.tempo), night: nightShare(t),
      };
    });
    const MOODS = [
      { id: 'gym', name: 'Gym', desc: 'Fast, high-energy songs to move to', hue: 8,
        score: (r) => r.energy * 1.2 + (between(r.f.tempo, 115, 175) ? 0.5 : r.f.tempo >= 100 ? 0.2 : -0.3) + r.steady * 0.3
          + r.g('Hip-Hop', 'Electronic', 'Rock', 'Metal', 'Punk') * 0.4 - r.g('Chill', 'R&B', 'Jazz', 'Classical', 'Acoustic') * 0.4 },
      { id: 'chill', name: 'Chill', desc: 'Calm, slower songs to unwind', hue: 200,
        score: (r) => (1 - r.energy) * 1.2 + (r.f.tempo < 105 ? 0.4 : 0) + (1 - r.bright) * 0.3
          + r.g('Chill', 'R&B', 'Jazz', 'Classical', 'Acoustic') * 0.4 - r.g('Metal', 'Punk') * 0.6 },
      { id: 'sad', name: 'Sad hours', desc: 'Slow, minor-key songs for when you’re in your feelings', hue: 225,
        score: (r) => -r.mode * 0.9 + (1 - r.energy) * 0.8 + (r.f.tempo < 100 ? 0.4 : 0) + (1 - r.bright) * 0.3
          + r.g('Acoustic', 'R&B', 'Classical') * 0.2 - r.g('Metal', 'Punk', 'Electronic') * 0.4 },
      { id: 'happy', name: 'Feel good', desc: 'Bright, upbeat songs to lift your mood', hue: 45,
        score: (r) => r.mode * 0.9 + (between(r.f.tempo, 100, 140) ? 0.4 : 0) + r.energy * 0.5 + r.bright * 0.2
          + r.g('Pop', 'R&B', 'Electronic') * 0.2 - r.g('Metal') * 0.4 },
      { id: 'drive', name: 'Late night drive', desc: 'Steady, moody songs for empty roads after dark', hue: 255, hours: [20, 4],
        score: (r) => (between(r.f.tempo, 85, 125) ? 0.5 : 0) + (1 - Math.abs(r.energy - 0.55) * 2) * 0.5 + r.steady * 0.4
          - r.mode * 0.3 + (1 - r.bright) * 0.6 - (r.energy > 0.85 ? 0.5 : 0) + r.night * 0.6
          + r.g('Electronic', 'R&B', 'Hip-Hop') * 0.2 - r.g('Metal', 'Punk') * 0.4 },
      { id: 'hype', name: 'Hype', desc: 'Your loudest, most intense songs', hue: 340,
        score: (r) => r.energy * 1.1 + r.bright * 0.7 + r.tempoRank * 0.3 + r.steady * 0.2 + r.g('Metal', 'Punk', 'Hip-Hop', 'Electronic') * 0.3 },
      { id: 'focus', name: 'Deep focus', desc: 'Steady, calm songs that stay out of the way', hue: 170, hours: [8, 18],
        score: (r) => r.steady * 0.8 + (1 - Math.abs(r.energy - 0.35) * 2) * 0.5 + (1 - r.bright) * 0.4 + (between(r.f.tempo, 70, 120) ? 0.3 : 0)
          + r.g('Classical', 'Electronic', 'Chill', 'Jazz') * 0.4 - r.g('Metal', 'Punk', 'Hip-Hop') * 0.5 },
      { id: 'rain', name: 'Rainy day', desc: 'Soft, slow and a little grey', hue: 210,
        score: (r) => -r.mode * 0.5 + (1 - r.energy) * 0.8 + (r.f.tempo < 95 ? 0.4 : 0) + (1 - r.bright) * 0.4
          + r.g('Acoustic', 'Jazz', 'Classical', 'Chill') * 0.4 - r.g('Metal', 'Punk', 'Electronic') * 0.5 },
      { id: 'morning', name: 'Morning coffee', desc: 'Light, warm songs to start the day', hue: 30, hours: [6, 11],
        score: (r) => r.mode * 0.6 + (1 - Math.abs(r.energy - 0.4) * 2) * 0.6 + (between(r.f.tempo, 80, 118) ? 0.4 : 0)
          + r.g('Acoustic', 'Jazz', 'Pop', 'R&B') * 0.3 - r.g('Metal', 'Punk') * 0.6 },
    ];
    const inHours = (h, [a, b]) => (a <= b ? h >= a && h < b : h >= a || h < b);
    for (const m of MOODS) {
      // the best ~30% of your library for this mood, if they really fit
      // what it hears in the song + how often its song/artist shows up in real
      // playlists for this mood (songs not analysed yet can get in on that alone)
      const sig = moodSignal(m.id);
      const heard = new Set(rows.map((r) => r.t.id));
      const ranked = [
        ...(analyzed.length >= 8 ? rows.map((r) => ({ id: r.t.id, sc: m.score(r) + sig(r.t) * 1.2 })) : []),
        ...all.filter((t) => analyzed.length < 8 || !heard.has(t.id)).map((t) => { const x = sig(t); return { id: t.id, sc: x >= 0.5 ? 0.9 + x : -9 }; }),
      ].sort((a, b) => b.sc - a.sc);
      const cut = Math.max(5, Math.ceil(all.length * 0.3));
      const ids = ranked.slice(0, cut).filter((x) => x.sc >= 0.9).map((x) => x.id);
      add(m.id, m.name, m.desc, shuffleWith(ids, seeded(day + m.id)), m.hue);
      if (m.hours && inHours(hour, m.hours)) timeFirst.add(m.id);
    }
  }

  // After dark: what *you* actually play late at night
  const nightIds = all
    .map((t) => ({ t, n: (t.plays || []).filter((x) => { const h = new Date(x).getHours(); return h >= 22 || h < 4; }).length }))
    .filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).map((x) => x.t.id);
  add('afterdark', 'After dark', 'What you play when everyone’s asleep', nightIds, 265);
  if (hour >= 21 || hour < 4) timeFirst.add('afterdark');

  // Forgotten gems: in your library a while, not played for 2+ months (or never)
  const gems = all
    .filter((t) => now - t.addedAt > MONTH && (!t.lastPlayed || now - t.lastPlayed > 2 * MONTH))
    .map((t) => t.id);
  add('gems', 'Forgotten gems', 'Songs you haven’t played in a while', shuffleWith(gems, seeded(`${day}gems`)), 95);

  // Genre mixes
  const byGenre = new Map();
  for (const t of all) {
    const fam = genreFamily(t.genre);
    if (fam) (byGenre.get(fam) || byGenre.set(fam, []).get(fam)).push(t.id);
  }
  for (const [fam, ids] of byGenre) {
    add(`genre:${fam}`, `${fam} mix`, `Your ${fam.toLowerCase()} songs`, shuffleWith(ids, seeded(day + fam)), hue(fam), 4);
  }

  // Artist mixes (a few different ones each day)
  const artistMixes = [...artistIndex().values()].filter((a) => a.ids.length >= 4);
  for (const a of shuffleWith(artistMixes, seeded(`${day}artists`)).slice(0, 3)) {
    add(`artist:${a.key}`, `${a.name} mix`, `Songs by ${a.name}`, shuffleWith(a.ids, seeded(day + a.key)), hue(a.key), 4);
  }

  // Played together: songs you usually listen to in the same sitting
  for (const mx of playedTogetherMixes(all)) add(mx.id, mx.name, mx.desc, mx.ids, mx.hue);

  // Inspired by popular playlists on other apps, rebuilt from your songs
  for (const mx of inspoMixes(all)) add(mx.id, mx.name, mx.desc, mx.ids, mx.hue);

  const shuffledMixes = shuffleWith(mixes, seeded(`${day}order`));
  mixCache = { key: key + '|' + [...timeFirst].join(','), mixes: [...shuffledMixes.filter((m) => timeFirst.has(m.id)), ...shuffledMixes.filter((m) => !timeFirst.has(m.id))] };
  return mixCache.mixes;
}

const findMix = (id) => computeMixes().find((m) => m.id === id);

const overlap = (a, b) => { const s = new Set(b); return a.filter((x) => s.has(x)).length / Math.max(1, Math.min(a.length, b.length)); };

// Songs you usually play in the same sitting (plays less than 40 min apart).
function playedTogetherMixes(all) {
  const plays = all.flatMap((t) => (t.plays || []).map((at) => ({ id: t.id, at }))).sort((a, b) => a.at - b.at);
  const sessions = [];
  let cur = [];
  for (let i = 0; i < plays.length; i++) {
    if (i && plays[i].at - plays[i - 1].at > 40 * 60e3) { sessions.push(cur); cur = []; }
    cur.push(plays[i].id);
  }
  sessions.push(cur);
  const pair = new Map(); // id -> Map(otherId -> sessions together)
  const count = new Map();
  for (const sess of sessions) {
    const ids = [...new Set(sess)];
    if (ids.length < 2 || ids.length > 60) continue;
    for (const a of ids) {
      count.set(a, (count.get(a) || 0) + 1);
      const m = pair.get(a) || pair.set(a, new Map()).get(a);
      for (const b of ids) if (a !== b) m.set(b, (m.get(b) || 0) + 1);
    }
  }
  const out = [];
  const seeds = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  for (const seed of seeds) {
    const partners = [...(pair.get(seed) || [])].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const ids = [seed, ...partners].slice(0, 30);
    if (ids.length < 5 || out.some((m) => overlap(m.ids, ids) > 0.5)) continue;
    const t = state.tracks.get(seed);
    out.push({ id: `together:${seed}`, name: out.length ? `${t.title} & co.` : 'Played together', desc: `Songs you usually play with “${t.title}”`, ids, hue: 310 + out.length * 20 });
    if (out.length >= 2) break;
  }
  return out;
}

// ---------- mood mixes that learn from real mood playlists ----------
const MOOD_QUERIES = {
  gym: 'gym workout', chill: 'chill vibes', sad: 'sad songs', happy: 'feel good', drive: 'late night drive',
  hype: 'pump up songs', focus: 'deep focus', rain: 'rainy day', morning: 'morning coffee',
};
state.moodLists = null; // { at, moods: { id: { songs: Set-able [[t, a]], artists: { name: count } } } }
let moodLoading = false;
async function loadMoodLists() {
  if (!configured() || moodLoading || !navigator.onLine) return;
  if (state.moodLists && Date.now() - state.moodLists.at < 7 * 86400e3 && state.tracks.size < (state.moodLists.size || 0) * 1.25 + 10) return; // weekly, or when your library grew a lot
  moodLoading = true;
  try {
    // search each mood plainly and in your favourite genre ("sad songs" + "sad songs rock")
    const fams = new Map();
    for (const t of state.tracks.values()) { const f = genreFamily(t.genre); if (f) fams.set(f, (fams.get(f) || 0) + 1); }
    const fav = [...fams].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const queries = Object.fromEntries(Object.entries(MOOD_QUERIES).map(([id, q]) => [id, fav ? [`${q} ${fav.toLowerCase()}`, q] : [q]]));
    const r = await api.moodLists(state.settings, queries);
    if (!r.moods || !Object.keys(r.moods).length) return;
    state.moodLists = { at: Date.now(), size: state.tracks.size, moods: r.moods };
    db.put('kv', state.moodLists, 'moodLists');
    moodSignals = null;
    mixCache.key = '';
    renderMixes();
  } catch {} finally { moodLoading = false; }
}

// 0..1: how much a song belongs in this mood according to real playlists.
// Exact song in them = 1; otherwise how often its artist shows up there.
let moodSignals = null;
function moodSignal(id) {
  const m = state.moodLists?.moods?.[id];
  if (!m) return () => 0;
  moodSignals ||= {};
  if (!moodSignals[id]) {
    const songs = new Set(m.songs.map(([t, a]) => `${songKey(t)}|${firstArtistKey(a)}`));
    const counts = new Map();
    for (const [a, n] of Object.entries(m.artists)) { const k = songKey(a); counts.set(k, (counts.get(k) || 0) + n); }
    const top = Math.max(1, ...counts.values());
    moodSignals[id] = (t) => {
      const artists = splitArtists(t.artist || '').map(songKey);
      if (artists.some((a) => songs.has(`${songKey(t.title)}|${a}`))) return 1;
      let best = 0;
      for (const a of artists) { const n = counts.get(a) || 0; if (n) best = Math.max(best, n >= 2 ? 0.3 + 0.3 * Math.sqrt(n / top) : 0.15); }
      return Math.min(0.6, best); // the artist fits; the song itself still has to sound right
    };
  }
  return moodSignals[id];
}

// ---------- playlist ideas from other apps ----------
// Popular public playlists (Deezer's catalogue, the same kind of playlists you
// see on Spotify / Apple Music) for your artists, genres and moods. Each one is
// rebuilt from songs you already have; it's only suggested if enough of yours fit.
state.inspo = null; // { day, playlists: [{ id, title, query, tracks: [[title, artist]] }] }
let inspoLoading = false;
const songKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s-\s.*$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
const firstArtistKey = (a) => songKey(splitArtists(a || '')[0] || a);

async function loadInspo() {
  if (!configured() || inspoLoading || state.tracks.size < 8 || !navigator.onLine) return;
  if (state.inspo?.day === todayKey()) return;
  inspoLoading = true;
  try {
    const rnd = seeded(`${todayKey()}inspo`);
    const fams = new Map();
    for (const t of state.tracks.values()) { const f = genreFamily(t.genre); if (f) fams.set(f, (fams.get(f) || 0) + 1); }
    const topFams = [...fams].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
    const flavours = ['classics', 'hits', 'essentials', 'anthems', '90s', '80s', '2000s'];
    const moods = ['chill', 'workout', 'road trip', 'sad songs', 'party', 'late night', 'summer', 'love songs', 'feel good', 'focus'];
    const queries = [
      ...discoverSeeds().slice(0, 3),
      ...topFams.map((f) => `${f} ${flavours[Math.floor(rnd() * flavours.length)]}`),
      ...shuffleWith(moods, rnd).slice(0, 3).map((m) => (topFams[0] && rnd() < 0.5 ? `${m} ${topFams[0]}` : m)),
    ];
    const r = await api.playlistInspo(state.settings, queries);
    state.inspo = { day: todayKey(), playlists: r.playlists || [] };
    db.put('kv', state.inspo, 'inspo');
    mixCache.key = '';
    renderMixes();
  } catch {} finally { inspoLoading = false; }
}

const tidyTitle = (s) => {
  let t = String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').split(/\s[|/:–-]\s|\s\/|:\s/)[0].replace(/\s+/g, ' ').trim();
  if (t === t.toUpperCase()) t = t.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return t.slice(0, 40);
};

function inspoMixes(all) {
  const lists = state.inspo?.playlists || [];
  if (!lists.length) return [];
  const byTitle = new Map();
  const byArtist = new Map();
  for (const t of all) {
    const k = songKey(t.title);
    if (k) (byTitle.get(k) || byTitle.set(k, []).get(k)).push(t);
    for (const a of splitArtists(t.artist || '')) { const ak = songKey(a); if (ak) (byArtist.get(ak) || byArtist.set(ak, []).get(ak)).push(t.id); }
  }
  const cands = [];
  const usedNames = new Set();
  for (const p of lists) {
    const exact = new Set();
    const plArtists = new Map(); // artist key -> how many songs in the playlist
    for (const [title, artist] of p.tracks) {
      const ak = firstArtistKey(artist);
      plArtists.set(ak, (plArtists.get(ak) || 0) + 1);
      for (const t of byTitle.get(songKey(title)) || []) {
        const mine = splitArtists(t.artist || '').map(songKey);
        if (!ak || mine.some((m) => m === ak || m.includes(ak) || ak.includes(m) || textSimilarity(m, ak) >= 0.8)) exact.add(t.id);
      }
    }
    // plus your other songs by artists the playlist features (a few each)
    const extra = [];
    for (const [ak, n] of [...plArtists].sort((a, b) => b[1] - a[1])) {
      const ids = (byArtist.get(ak) || []).filter((id) => !exact.has(id));
      extra.push(...shuffleWith(ids, seeded(p.id + ak)).slice(0, n >= 3 ? 3 : 2));
    }
    const ids = [...new Set([...exact, ...extra])].slice(0, 30);
    const artists = new Set(ids.map((id) => firstArtistKey(state.tracks.get(id)?.artist)));
    if (ids.length < 6 || artists.size < 2 || (exact.size < 2 && artists.size < 3)) continue;
    const name = tidyTitle(p.title);
    if (!name || usedNames.has(name.toLowerCase())) continue;
    cands.push({ p, name, ids, score: exact.size * 3 + ids.length + artists.size });
  }
  const out = [];
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    if (out.some((m) => overlap(m.ids, c.ids) > 0.6) || usedNames.has(c.name.toLowerCase())) continue;
    usedNames.add(c.name.toLowerCase());
    out.push({ id: `inspo:${c.p.id}`, name: c.name, desc: `Your songs, inspired by the popular “${c.p.title}” playlist`, ids: shuffleWith(c.ids, seeded(todayKey() + c.p.id)), hue: hue(c.name) });
    if (out.length >= 6) break;
  }
  return out;
}

function mixArt(mx, cls = '') {
  const ids = [...new Set(mx.ids)].filter((id) => state.tracks.get(id)?.cover).slice(0, 4);
  const cells = ids.length >= 4
    ? `<div class="mix-covers">${ids.map((id) => { const u = coverUrlFor(id); return u ? `<div class="has-img" style="background-image:url('${u}')"></div>` : `<div data-cover="${id}"></div>`; }).join('')}</div>`
    : '';
  return `<div class="art mix ${cls}" style="--h:${mx.hue}">${cells}<span class="mix-label">${esc(mx.name.replace(/ mix$/, ''))}</span></div>`;
}

function renderMixes() {
  const el = $('#mixes');
  if (!el) return;
  const mixes = state.libTab === 'songs' && !state.search ? computeMixes().slice(0, 14) : [];
  el.innerHTML = mixes.length
    ? `<h3 class="section-title">Made for you</h3><div class="recent-row">${mixes.map((mx) =>
        `<button class="recent-item mix-item" data-action="open-mix" data-id="${esc(mx.id)}">${mixArt(mx)}<span class="s">${plural(mx.ids.length, 'song')}</span></button>`).join('')}</div>`
    : '';
  hydrateCovers(el);
}

function mixHTML(mx) {
  const ts = mx.ids.map((id) => state.tracks.get(id)).filter(Boolean);
  const total = ts.reduce((s, t) => s + (t.duration || 0), 0);
  return `
    <button class="back" data-action="back-library">${icon('chevron-left')} Library</button>
    <div class="pl-head">
      ${mixArt(mx, 'big')}
      <div class="meta"><h2>${esc(mx.name)}</h2><div class="muted small">${esc(mx.desc)}</div><div class="muted small">${plural(ts.length, 'song')}${total ? ` · ${fmtTotal(total)}` : ''}</div></div>
    </div>
    <div class="actions-row">
      <button class="pill primary" data-action="play-list">${icon('play')} Play</button>
      <button class="pill" data-action="shuffle-list">${icon('shuffle')} Shuffle</button>
      <button class="pill" data-action="save-mix">${icon('plus')} Save</button>
    </div>
    <div id="list" class="list"></div>`;
}

// Turn a mix into a normal playlist you can edit.
async function saveMix(mx) {
  const v = await form('Save as playlist', [{ name: 'name', label: 'Name', value: mx.name }], 'Save');
  const name = v?.name?.trim();
  if (!name) return;
  const pl = { id: uid(), name, trackIds: mx.ids.slice(), createdAt: Date.now() };
  changePlaylists((items) => items.push(pl));
  toast(`Saved “${name}” to Playlists`);
  state.view = { name: 'playlist', id: pl.id };
  renderView();
}

// ---------- discover: new songs like the ones you play ----------
// Songs you don't have yet by artists similar to your favourites, as official
// 30-second previews. Like one? Open it in Spotify or Apple Music and save it there.
state.discover = null; // { day, groups: [{ because, tracks }], links: { id: appleUrl } }
let discoverHidden = new Set();
let discoverLoading = false;
const todayKey = () => new Date().toLocaleDateString('en-CA'); // your local date, YYYY-MM-DD
const flatKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const discoverTracks = () => (state.discover?.groups || []).flatMap((g) => g.tracks);

// Your favourite artists: the ones you play most (recent plays count more), then the ones you have most songs by.
function discoverSeeds() {
  const now = Date.now();
  const scored = [...artistIndex().values()].map((a) => {
    let score = a.ids.length * 0.5;
    for (const id of a.ids) for (const at of state.tracks.get(id)?.plays || []) score += Math.max(0.2, 1 - (now - at) / (60 * 86400e3));
    return { name: a.name, score };
  }).sort((x, y) => y.score - x.score);
  return scored.slice(0, 6).map((x) => x.name);
}

async function loadDiscover(force = false) {
  if (!configured() || discoverLoading || !state.tracks.size || !navigator.onLine) return;
  if (!force && state.discover?.day === todayKey() && state.discover.v === 2 && state.discover.groups.length) return;
  discoverLoading = true;
  if (force) toast('Finding new songs…');
  renderDiscoverRow();
  try {
    const artists = artistIndex();
    const known = [...artists.values()].flatMap((a) => [...a.variants]);
    const r = await api.discover(state.settings, { seeds: discoverSeeds(), known, hidden: [...discoverHidden], day: force ? `${todayKey()}-${Date.now()}` : todayKey() });
    const have = new Set([...state.tracks.values()].map((t) => flatKey(t.title)));
    const fresh = (t) => !have.has(flatKey(t.title)) && !discoverHidden.has(t.id);
    const similar = (r.groups || []).map((g) => ({ ...g, tracks: g.tracks.filter(fresh) })).filter((g) => g.tracks.length);
    // "More from Radiohead": their popular songs you don't have yet (a few, changing daily)
    const rnd = seeded(`${todayKey()}more${force ? Date.now() : ''}`);
    const more = (r.more || []).map((g) => {
      const seenT = new Set();
      const list = g.tracks.filter(fresh).filter((t) => { const k = flatKey(t.title); if (seenT.has(k)) return false; seenT.add(k); return true; });
      const top = list.slice(0, 4);
      const rest = shuffleWith(list.slice(4), rnd).slice(0, 2);
      return { ...g, tracks: [...top.slice(0, 3), ...rest, ...top.slice(3)].slice(0, 5) };
    }).filter((g) => g.tracks.length);
    // mix them: a "more from" section, then a "because you like" one, and so on
    const groups = [];
    for (let i = 0; i < Math.max(similar.length, more.length); i++) { if (more[i]) groups.push(more[i]); if (similar[i]) groups.push(similar[i]); }
    // each song once on the page (no live versions / covers of the same title twice)
    const shown = new Set();
    for (const g of groups) g.tracks = g.tracks.filter((t) => { const k = flatKey(t.title); if (shown.has(k)) return false; shown.add(k); return true; });
    for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].tracks.length) groups.splice(i, 1);
    state.discover = { v: 2, day: todayKey(), groups, links: {} };
    db.put('kv', state.discover, 'discover');
    if (force) toast(groups.length ? 'New picks ready' : 'No new songs found right now');
    refreshDiscover();
    // Apple Music links, so that button opens the exact song
    const all = discoverTracks();
    for (let i = 0; i < all.length; i += 20) {
      const { links } = await api.discoverLinks(state.settings, all.slice(i, i + 20).map(({ id, title, artist }) => ({ id, title, artist })));
      Object.assign(state.discover.links, links);
    }
    db.put('kv', state.discover, 'discover');
    if (state.view.name === 'discover') refreshDiscover();
  } catch (err) {
    if (force) toast(err.message);
  } finally {
    discoverLoading = false;
    refreshDiscover();
  }
}

function refreshDiscover() {
  if (state.view.name === 'discover') { const y = window.scrollY; $('#view').innerHTML = discoverHTML(); window.scrollTo(0, y); paintPreview(); }
  else renderDiscoverRow();
}

function renderDiscoverRow() {
  const el = $('#discover');
  if (!el) return;
  const groups = state.libTab === 'songs' && !state.search ? state.discover?.groups || [] : [];
  // one from each "because you like", round-robin, so the row is varied
  const picks = [];
  for (let i = 0; picks.length < 12 && groups.some((g) => g.tracks[i]); i++) for (const g of groups) if (g.tracks[i] && picks.length < 12) picks.push(g.tracks[i]);
  el.innerHTML = picks.length
    ? `<div class="section-head"><h3 class="section-title">Discover new music</h3><button class="link" data-action="open-discover">See all</button></div>
      <div class="recent-row">${picks.map((t) => `<button class="recent-item" data-action="open-discover" data-id="${esc(t.id)}">
        <div class="art disc-art" style="background-image:url('${esc(t.cover)}')"><span class="disc-play">${icon('play')}</span></div>
        <span class="t">${esc(t.title)}</span><span class="s">${esc(t.artist)}</span></button>`).join('')}</div>`
    : '';
}

const spotifyUrl = (t) => `https://open.spotify.com/search/${encodeURIComponent(`${t.title} ${t.artist}`)}`;
const appleUrl = (t) => state.discover?.links?.[t.id] || `https://music.apple.com/search?term=${encodeURIComponent(`${t.title} ${t.artist}`)}`;

function discoverHTML() {
  const groups = state.discover?.groups || [];
  return `
    <div class="pl-head disc-head">
      <div class="meta">
        <div class="muted small">Songs you don't have yet, picked from what you listen to. Tap to hear 30 seconds — like it? Save it in Spotify or Apple Music. New picks every day.</div></div>
    </div>
    <div class="actions-row"><button class="pill" data-action="disc-refresh" ${discoverLoading ? 'disabled' : ''}>${icon('sync')} ${discoverLoading ? 'Finding songs…' : 'New picks'}</button></div>
    ${groups.length ? groups.map((g) => `
      <h3 class="section-title disc-because">${g.kind === 'more' ? 'More from' : 'Because you like'} <b>${esc(g.because)}</b></h3>
      <div class="list">${g.tracks.map((t) => `
        <div class="row disc-row" data-disc="${esc(t.id)}">
          <button class="disc-cover" data-action="disc-play" data-id="${esc(t.id)}" aria-label="Play preview" style="background-image:url('${esc(t.cover)}')"><span class="disc-play">${icon('play')}</span></button>
          <div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div>
            <div class="disc-links">
              <a class="mini-pill spotify" href="${esc(spotifyUrl(t))}" target="_blank" rel="noopener">Spotify</a>
              <a class="mini-pill apple" href="${esc(appleUrl(t))}" target="_blank" rel="noopener">Apple Music</a>
            </div>
          </div>
          <button class="icon-btn" data-action="disc-hide" data-id="${esc(t.id)}" aria-label="Not for me">${icon('x')}</button>
          <div class="disc-progress"></div>
        </div>`).join('')}</div>`).join('')
      : `<p class="muted center">${discoverLoading ? 'Finding songs you might like…' : configured() ? 'Play some music first, then come back for suggestions.' : 'Connect your server in Settings to get suggestions.'}</p>`}`;
}

async function hideDiscover(id) {
  discoverHidden.add(id);
  db.put('kv', [...discoverHidden].slice(-2000), 'discoverHidden');
  if (preview.dataset.id === id) preview.pause();
  if (state.discover) {
    state.discover.groups = state.discover.groups.map((g) => ({ ...g, tracks: g.tracks.filter((t) => t.id !== id) })).filter((g) => g.tracks.length);
    db.put('kv', state.discover, 'discover');
  }
  refreshDiscover();
  toast('Got it — hidden');
}

// The 30-second preview player (separate from your own music).
const preview = new Audio();
preview.preload = 'none';
function playPreview(id) {
  if (preview.dataset.id === id && !preview.paused) { preview.pause(); return; }
  if (player.playing) player.toggle();
  if (preview.dataset.id !== id) { preview.src = api.previewUrl(state.settings, id); preview.dataset.id = id; }
  preview.play().catch(() => toast("Couldn't play that preview"));
  paintPreview();
}
function paintPreview() {
  const playing = !preview.paused;
  $$('.disc-row').forEach((row) => {
    const on = row.dataset.disc === preview.dataset.id;
    row.classList.toggle('playing', on && playing);
    row.querySelector('.disc-play').innerHTML = icon(on && playing ? 'pause' : 'play');
    if (!on) row.style.removeProperty('--p');
  });
}
preview.addEventListener('play', paintPreview);
preview.addEventListener('pause', paintPreview);
preview.addEventListener('timeupdate', () => {
  const row = $(`.disc-row[data-disc="${CSS.escape(preview.dataset.id || '')}"]`);
  if (row) row.style.setProperty('--p', `${(preview.currentTime / (preview.duration || 30)) * 100}%`);
});
preview.addEventListener('ended', () => { // carry on with the next suggestion
  const all = discoverTracks();
  const i = all.findIndex((t) => t.id === preview.dataset.id);
  if (state.view.name === 'discover' && all[i + 1]) playPreview(all[i + 1].id);
  else paintPreview();
});
preview.addEventListener('error', () => { if (preview.dataset.id) toast("Couldn't play that preview"); });

// ---------- song info: check & fix the whole library ----------
const missingGenre = (t) => !t.genre;
const missingCover = (t) => !t.cover;

function songInfoCard() {
  const all = [...state.tracks.values()];
  const noGenre = all.filter(missingGenre).length;
  const noCover = all.filter(missingCover).length;
  const fixed = all.filter((t) => t.origTitle).length;
  const ok = all.length - all.filter((t) => missingGenre(t) || missingCover(t)).length;
  return `
    <section class="card">
      <h3>Song info</h3>
      <div class="stats">
        <div><b>${ok}</b><span>complete</span></div>
        <div class="${noGenre ? 'warn' : ''}"><b>${noGenre}</b><span>no genre</span></div>
        <div class="${noCover ? 'warn' : ''}"><b>${noCover}</b><span>no cover</span></div>
        <div><b>${fixed}</b><span>names fixed</span></div>
      </div>
      <p class="muted small">Looks every song up again: fills in missing genres and covers, and fixes messy titles and artists (swapped, typos, “official video”…). Names you edited yourself are never changed.</p>
      <div class="row-btns">
        ${noGenre || noCover ? `<button class="pill primary" data-action="fix-missing">${icon('search')} Fix songs missing info</button>` : ''}
        <button class="pill${noGenre || noCover ? '' : ' primary'}" data-action="fix-all">${icon('sync')} Check & fix all songs</button>
        ${noGenre || noCover ? `<button class="pill ghost" data-action="missing-info">See which songs</button>` : ''}
      </div>
    </section>`;
}

let fixingAll = false;
async function fixAllSongs({ onlyMissing = false } = {}) {
  if (fixingAll || !configured()) return;
  fixingAll = true;
  const total = onlyMissing ? [...state.tracks.values()].filter((t) => missingGenre(t) || missingCover(t)).length : state.tracks.size;
  const report = { renamed: [], genres: 0, covers: 0, retry: 0 };
  try {
    let after = '';
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      toast(`Checking songs… ${Math.min(checked, total)} / ${total}`);
      const r = await api.fixLibrary(state.settings, after, { onlyMissing });
      report.renamed.push(...r.renamed);
      report.genres += r.genres;
      report.covers += r.covers;
      report.retry += r.retry;
      checked += 5;
      after = r.after;
      if (r.done) break;
    }
    await sync();
    const lines = [
      `${plural(report.renamed.length, 'name')} fixed · ${plural(report.genres, 'genre')} · ${plural(report.covers, 'cover')} found`,
      ...(report.retry ? [`${plural(report.retry, 'song')} couldn’t be checked (music search busy) — try again later`] : []),
    ];
    await menu('Done checking', [
      ...report.renamed.slice(0, 30).map((r) => ({ key: `r:${r.id}`, label: `${r.from}  →  ${r.to}`, icon: 'edit' })),
      ...(state.tracks.size && [...state.tracks.values()].some((t) => missingGenre(t) || missingCover(t))
        ? [{ key: 'missing', label: 'See songs still missing info', icon: 'search' }] : []),
    ], lines.join('\n')).then((k) => { if (k === 'missing') showMissingInfo(); });
  } catch (err) {
    toast(err.message);
  } finally {
    fixingAll = false;
    if (state.view.name === 'settings') renderView();
  }
}

// A list of songs without a genre or cover; tap one to fix it.
async function showMissingInfo() {
  const list = [...state.tracks.values()].filter((t) => missingGenre(t) || missingCover(t))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  if (!list.length) return toast('Every song has a genre and a cover 🎉');
  const key = await menu(`${plural(list.length, 'song')} missing info`,
    list.map((t) => ({
      key: t.id,
      label: `${t.title}${t.artist ? ` · ${t.artist}` : ''} — ${[missingGenre(t) && 'no genre', missingCover(t) && 'no cover'].filter(Boolean).join(', ')}`,
      icon: 'edit',
    })),
    'Tap a song to edit it, set a genre, or pick a cover.');
  if (key) trackMenu(key, '');
}

// ---------- recently played ----------
function addRecent(item) {
  state.recent = [{ ...item, at: Date.now() }, ...state.recent.filter((r) => !(r.type === item.type && r.id === item.id))].slice(0, 12);
  db.put('kv', state.recent, 'recent');
  renderRecent();
  state.pending.recentDirty = true;
  savePending();
  scheduleHistoryPush();
}

function recentEntries() {
  const artists = artistIndex();
  return state.recent.map((r) => {
    if (r.type === 'track') { const t = state.tracks.get(r.id); return t && { r, label: t.title, sub: t.artist || 'Song', html: art(t.id, t.title) }; }
    if (r.type === 'playlist') { const pl = findPlaylist(r.id); return pl && { r, label: pl.name, sub: 'Playlist', html: playlistArt(pl) }; }
    if (r.type === 'mix') { const mx = findMix(r.id); return mx && { r, label: mx.name, sub: 'Made for you', html: mixArt(mx) }; }
    if (r.type === 'artist') { const a = artists.get(r.id); return a && { r, label: a.name, sub: 'Artist', html: artistArt(a) }; }
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
  if (state.view.name === 'mix') return { type: 'mix', id: state.view.id };
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
        <button class="pill" data-action="remove-downloads">Free up space</button>` : ''}
      </div>
    </section>
    ${configured() ? songInfoCard() : ''}
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
          ${artistArt(a)}
          <div class="meta"><div class="t">${esc(a.name)}</div><div class="s">${plural(a.ids.length, 'track')}</div></div>
          <span class="chev">${icon('chevron-right')}</span>
        </div>`).join('')
      : emptyHTML(q ? 'Nothing found' : 'No artists yet', q ? 'Try a different search.' : 'Add the artist to your songs with ••• → Edit title & artist.');
    checkArtistPhotos(list);
  } else if (state.view.name === 'artist') {
    const a = artistIndex().get(state.view.key);
    if (a) checkArtistPhotos([a]);
    const ts = a ? a.ids.map((id) => state.tracks.get(id)).filter(Boolean) : [];
    listIds = ts.map((t) => t.id);
    el.innerHTML = ts.map((t, i) => rowHTML(t, i)).join('');
  } else if (state.view.name === 'mix') {
    const mix = findMix(state.view.id);
    const ts = mix ? mix.ids.map((id) => state.tracks.get(id)).filter(Boolean) : [];
    listIds = ts.map((t) => t.id);
    el.innerHTML = ts.map((t, i) => rowHTML(t, i)).join('');
  } else if (state.view.name === 'library') {
    renderMixes();
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
  spinVinyl();
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

// ---------- lyrics (from LRCLIB, a free lyrics database) ----------
// Synced lyrics scroll with the song; tap a line to jump there. Saved on the
// device after the first time, so they work offline too.
const LYRICS_NONE_RETRY = 30 * 86400e3;
const lyricsKey = (t) => `${t.title}|${t.artist || ''}`;
const lyricsJobs = new Map();
let lyricsShown = false;
let lyricsFor = null; // { id, data }
let lyricsLine = -1;
let lyricsUserScroll = 0;

function parseLRC(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const line = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push([Number(m[1]) * 60 + Number(m[2]), line]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

async function lrclib(path) {
  const r = await fetch(`https://lrclib.net/api/${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Lyrics service busy');
  return r.json();
}

async function fetchLyrics(t) {
  const title = t.title.replace(/\s*[([](feat|ft|with)\b.*?[)\]]/i, '').trim();
  const artist = splitArtists(t.artist || '')[0] || '';
  const q = (o) => new URLSearchParams(o).toString();
  let hit = t.duration
    ? await lrclib(`get?${q({ track_name: title, artist_name: artist, duration: Math.round(t.duration) })}`)
    : null;
  if (!hit?.syncedLyrics && !hit?.instrumental) {
    let list = (artist && (await lrclib(`search?${q({ track_name: title, artist_name: artist })}`))) || [];
    if (!list.length) list = (await lrclib(`search?${q({ q: `${title} ${artist}`.trim() })}`)) || [];
    const ta = songKey(artist);
    const fits = list.filter((x) => songKey(x.trackName) === songKey(title) || textSimilarity(songKey(x.trackName), songKey(title)) >= 0.8)
      .filter((x) => !ta || textSimilarity(songKey(x.artistName), ta) >= 0.7 || songKey(x.artistName).includes(ta));
    const score = (x) => (x.syncedLyrics ? 0 : 100) + (t.duration && x.duration ? Math.abs(x.duration - t.duration) : 30);
    const best = fits.sort((a, b) => score(a) - score(b))[0];
    if (best && (!hit || best.syncedLyrics)) hit = best;
  }
  return {
    key: lyricsKey(t),
    at: Date.now(),
    synced: hit?.syncedLyrics ? parseLRC(hit.syncedLyrics) : [],
    plain: hit?.plainLyrics || '',
    instrumental: !!hit?.instrumental,
  };
}

// Cached lyrics for a song, fetching them if needed (null = still unknown / offline).
function getLyrics(id) {
  const t = state.tracks.get(id);
  if (!t) return Promise.resolve(null);
  if (lyricsJobs.has(id)) return lyricsJobs.get(id);
  const job = (async () => {
    const cached = await db.get('kv', `lyrics:${id}`);
    const empty = cached && !cached.synced.length && !cached.plain && !cached.instrumental;
    if (cached && cached.key === lyricsKey(t) && !(empty && Date.now() - cached.at > LYRICS_NONE_RETRY)) return cached;
    if (!navigator.onLine) return cached || null;
    try {
      const data = await fetchLyrics(t);
      await db.put('kv', data, `lyrics:${id}`);
      return data;
    } catch { return cached || null; }
  })().finally(() => lyricsJobs.delete(id));
  lyricsJobs.set(id, job);
  return job;
}

function toggleLyrics(on = !lyricsShown) {
  lyricsShown = on;
  $('#player').classList.toggle('show-lyrics', on);
  $('#lyrics').hidden = !on;
  $('#lyricsBtn').textContent = on ? 'Vinyl' : 'Lyrics';
  $('#lyricsBtn').classList.toggle('on', on);
  if (on) renderLyrics();
  spinVinyl();
}

async function renderLyrics() {
  const id = player.currentId;
  const el = $('#lyrics');
  if (!lyricsShown || !id) return;
  if (lyricsFor?.id !== id) {
    lyricsFor = { id, data: null };
    lyricsLine = -1;
    el.innerHTML = '<p class="lyrics-msg"><span class="spinner"></span></p>';
    const data = await getLyrics(id);
    if (player.currentId !== id) return;
    lyricsFor = { id, data };
    el.scrollTop = 0;
  }
  const d = lyricsFor.data;
  if (!d) { el.innerHTML = `<p class="lyrics-msg">${navigator.onLine ? 'Couldn’t load lyrics right now' : 'Lyrics need internet the first time'}</p>`; return; }
  if (d.synced.length) {
    el.innerHTML = `<div class="lyrics-pad"></div>${d.synced.map(([time, line], i) =>
      `<p class="lyr" data-action="lyric-seek" data-i="${i}" data-time="${time}">${esc(line) || '♪'}</p>`).join('')}<div class="lyrics-pad"></div>`;
    lyricsLine = -1;
    syncLyrics(true);
  } else if (d.plain) {
    el.innerHTML = `<div class="lyrics-plain">${esc(d.plain)}</div><p class="lyrics-msg small">These lyrics aren’t timed to the song</p>`;
  } else {
    el.innerHTML = `<p class="lyrics-msg">${d.instrumental ? 'Instrumental ♪' : 'No lyrics found for this song'}</p>`;
  }
}

// Highlight the line being sung and keep it in the middle.
function syncLyrics(jump = false) {
  if (!lyricsShown || !lyricsFor?.data?.synced?.length || lyricsFor.id !== player.currentId) return;
  const cur = player.isSilent ? 0 : player.audio.currentTime + 0.2;
  const lines = lyricsFor.data.synced;
  let i = -1;
  for (let k = 0; k < lines.length && lines[k][0] <= cur; k++) i = k;
  if (i === lyricsLine && !jump) return;
  lyricsLine = i;
  const el = $('#lyrics');
  el.querySelectorAll('.lyr.on').forEach((p) => p.classList.remove('on'));
  const p = i >= 0 ? el.querySelector(`.lyr[data-i="${i}"]`) : null;
  if (p) p.classList.add('on');
  if (Date.now() - lyricsUserScroll < 3500) return; // you're scrolling yourself
  const target = p || el.querySelector('.lyr');
  if (target) el.scrollTo({ top: target.offsetTop - el.clientHeight / 2 + target.clientHeight / 2, behavior: jump ? 'auto' : 'smooth' });
}

// Fetch lyrics for the whole library in the background, gently (once per app start).
let lyricsFilling = false;
async function fillLyrics() {
  if (lyricsFilling || !navigator.onLine) return;
  lyricsFilling = true;
  try {
    const have = new Set((await db.keys('kv')).filter((k) => String(k).startsWith('lyrics:')).map((k) => k.slice(7)));
    const todo = [...state.tracks.values()].filter((t) => !have.has(t.id)).sort(newestFirst);
    for (const t of todo) {
      if (!navigator.onLine) break;
      await getLyrics(t.id);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally { lyricsFilling = false; }
}

function openPlayer() {
  const p = $('#player');
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
  spinVinyl();
}
function closePlayer() {
  const p = $('#player');
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
  spinVinyl();
}

// The record turns once every 3.2 s while music plays and the player is open.
// Done frame by frame (keeps its angle when paused, never snaps back).
const SPIN_MS = 3200;
const calmMotion = matchMedia('(prefers-reduced-motion: reduce)');
let vinylAngle = 0;
let spinFrame = 0;
let spinLast = 0;
function spinStep(ts) {
  if (spinLast) vinylAngle = (vinylAngle + ((ts - spinLast) * 360) / SPIN_MS) % 360;
  spinLast = ts;
  $('#turntable .vinyl').style.transform = `rotate(${vinylAngle.toFixed(2)}deg)`;
  spinFrame = requestAnimationFrame(spinStep);
}
function spinVinyl() {
  const on = player.playing && !calmMotion.matches && !document.hidden && !lyricsShown && $('#player').classList.contains('open');
  if (on && !spinFrame) { spinLast = 0; spinFrame = requestAnimationFrame(spinStep); }
  else if (!on && spinFrame) { cancelAnimationFrame(spinFrame); spinFrame = 0; }
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
        ${fields.map((f) => `<label class="field"><span>${esc(f.label)}</span><input name="${f.name}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"${f.options ? ` list="dl-${f.name}"` : ''}>${f.options ? `<datalist id="dl-${f.name}">${f.options.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}</label>`).join('')}
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

// lower-case, no accents or punctuation: "Guns N' Roses" -> "guns n roses"
const findText = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function picker(title, tracks) {
  return new Promise((resolve) => {
    openSheet(`
      <div class="sheet-head"><div class="t">${esc(title)}</div></div>
      <label class="search pick-search">${icon('search')}<input type="search" placeholder="Search songs or artists" autocomplete="off" autocorrect="off"></label>
      <div class="pick-list">${tracks.map((t) => `<label class="row pick" data-find="${esc(findText(`${t.title} ${t.artist || ''}`))}"><input type="checkbox" value="${t.id}">${art(t.id, t.title)}<div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist || fmtTime(t.duration))}</div></div></label>`).join('')}</div>
      <div class="sheet-foot"><button class="pill" data-cancel>Cancel</button><button class="pill primary" data-done>Add</button></div>`, resolve);
    const sheet = $('#sheet');
    hydrateCovers(sheet);
    sheet.onclick = null;
    const done = sheet.querySelector('[data-done]');
    sheet.onchange = () => {
      const n = sheet.querySelectorAll('.row.pick input:checked').length;
      done.textContent = n ? `Add ${n}` : 'Add';
    };
    // type to narrow the list down (ticked songs stay ticked while you search)
    const rows = [...sheet.querySelectorAll('.row.pick')];
    const box = sheet.querySelector('.pick-search input');
    const list = sheet.querySelector('.pick-list');
    let empty = null;
    box.oninput = () => {
      const words = findText(box.value).split(' ').filter(Boolean);
      let shown = 0;
      // each word must appear, or be a near-miss of a word in the song (typos like "metalica")
      const fits = (text, w) => text.includes(w) || (w.length >= 4 && text.split(' ').some((x) => x.length >= 4 && textSimilarity(x.slice(0, w.length + 1), w) >= 0.75));
      for (const r of rows) { const ok = words.every((w) => fits(r.dataset.find, w)); r.hidden = !ok; if (ok) shown++; }
      if (!shown && !empty) { empty = document.createElement('p'); empty.className = 'muted center'; empty.textContent = 'No songs match'; list.append(empty); }
      if (empty) empty.hidden = !!shown;
      list.scrollTop = 0;
    };
    box.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); box.blur(); } };
    sheet.querySelector('[data-cancel]').onclick = () => closeSheet(null);
    done.onclick = () => closeSheet([...sheet.querySelectorAll('.row.pick input:checked')].map((i) => i.value));
  });
}

// Search Apple Music + Deezer and let you tap the right cover.
function coverPicker(t) {
  return imagePicker({
    title: 'Choose a cover',
    hint: 'Search by artist and song name, then tap the right one.',
    query: [t.artist, t.title].filter(Boolean).join(' '),
    search: (q) => api.coverOptions(state.settings, t.id, q),
  });
}

// A sheet with a search box and a grid of images to tap.
function imagePicker({ title, hint, query, search, round = false }) {
  return new Promise((resolve) => {
    const q = query;
    openSheet(`
      <div class="sheet-head"><div class="t">${esc(title)}</div><div class="s">${esc(hint)}</div></div>
      <form class="cover-search" autocomplete="off">
        <input name="q" type="search" value="${esc(q)}" placeholder="Search">
        <button class="pill primary" type="submit">Search</button>
      </form>
      <div class="cover-grid${round ? ' round' : ''}"></div>
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
        const r = await search(query);
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
    ...(t.origTitle && configured() ? [{ key: 'restore', label: `Restore original name (“${t.origTitle}”)`, icon: 'x' }] : []),
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
    case 'restore':
      try {
        const st = await api.restoreName(state.settings, id);
        Object.assign(t, { title: st.title, artist: st.artist, origTitle: '', origArtist: '' });
        await db.put('tracks', t);
        renderView();
        renderPlayer();
        toast('Original name restored');
      } catch (err) { toast(err.message); }
      break;
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
    { name: 'genre', label: 'Genre', value: t.genre, placeholder: 'e.g. Hip-Hop, Metal, Chill', options: knownGenres() },
  ]);
  if (!v) return;
  t.title = v.title.trim() || t.title;
  t.artist = v.artist.trim();
  t.genre = (v.genre || '').trim();
  await db.put('tracks', t);
  if (!isPendingUpload(t.id) && !state.pending.renames.includes(t.id)) state.pending.renames.push(t.id);
  await savePending();
  renderView();
  renderPlayer();
  if (player.currentId === t.id) player.updateMetadata();

  // Genre left empty: look the song up again with the corrected title/artist.
  if (!t.genre && configured() && cloudCopy(t.id) && navigator.onLine) {
    try {
      await api.updateTrack(state.settings, t); // the server needs the new title first
      state.pending.renames = state.pending.renames.filter((x) => x !== t.id);
      await savePending();
      toast('Looking up genre…');
      const r = await api.lookupTrack(state.settings, t.id);
      const st = r.track;
      const gotCover = st.cover && st.cover !== t.cover;
      t.genre = st.genre || '';
      t.cover = st.cover;
      await db.put('tracks', t);
      renderView();
      renderPlayer();
      if (player.currentId === t.id) player.updateMetadata();
      if (t.genre) toast(`Genre: ${t.genre}${gotCover ? ' · cover added' : ''}`);
      else toast(r.retry ? 'Music search is busy — try again in a minute' : 'No genre found — you can type one in Edit');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
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
        } else if (type === 'mix') {
          state.view = { name: 'mix', id };
          renderView();
        }
        $('#view').scrollTop = 0;
        break;
      }
      case 'open-mix':
        state.view = { name: 'mix', id: el.dataset.id };
        renderView();
        $('#view').scrollTop = 0;
        break;
      case 'back-library':
        state.view = { name: 'library' };
        renderView();
        break;
      case 'open-discover': state.view = { name: 'discover' }; renderView(); window.scrollTo(0, 0); if (el.dataset.id) { playPreview(el.dataset.id); $(`.disc-row[data-disc="${CSS.escape(el.dataset.id)}"]`)?.scrollIntoView({ block: 'center' }); } break;
      case 'disc-play': playPreview(el.dataset.id); break;
      case 'disc-hide': hideDiscover(el.dataset.id); break;
      case 'disc-refresh': loadDiscover(true); break;
      case 'save-mix': { const mx = findMix(state.view.id); if (mx) saveMix(mx); break; }
      case 'queue-up': player.moveUp(Number(el.dataset.pos)); break;
      case 'queue-remove': player.removeAt(Number(el.dataset.pos)); break;
      case 'queue-clear': player.clearUpcoming(); break;
      case 'artist-menu': { const a = artistIndex().get(state.view.key); if (a) artistMenu(a); break; }
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
      case 'fix-all': fixAllSongs(); break;
      case 'fix-missing': fixAllSongs({ onlyMissing: true }); break;
      case 'missing-info': showMissingInfo(); break;
      case 'open-player': openPlayer(); break;
      case 'toggle-lyrics': toggleLyrics(); break;
      case 'lyric-seek': {
        const time = Number(el.dataset.time);
        if (!player.isSilent && isFinite(time)) { player.audio.currentTime = Math.max(0, time - 0.05); lyricsUserScroll = 0; if (!player.playing) player.toggle(); syncLyrics(true); }
        break;
      }
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

  // Mouse: grab and drag the "Made for you" / "Recently played" rows sideways.
  // (Touch screens and trackpads already scroll them natively.)
  let drag = null;
  let suppressClick = false;
  document.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.recent-row');
    if (!row || e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = { row, x: e.clientX, left: row.scrollLeft, moved: false, id: e.pointerId };
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 5) {
      drag.moved = true;
      drag.row.classList.add('dragging');
      drag.row.setPointerCapture?.(e.pointerId);
    }
    if (drag.moved) { drag.row.scrollLeft = drag.left - dx; e.preventDefault(); }
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
    drag.row.classList.remove('dragging');
    drag = null;
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  // a drag shouldn't also open the mix you let go on
  document.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; } }, true);

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
  document.addEventListener('visibilitychange', spinVinyl);
  player.audio.addEventListener('timeupdate', () => syncLyrics());
  player.audio.addEventListener('seeked', () => syncLyrics(true));
  player.addEventListener('change', () => {
    if (lyricsShown && lyricsFor?.id !== player.currentId) renderLyrics();
    const next = player.queue[player.index + 1]; // have the next song's lyrics ready
    if (player.currentId) getLyrics(player.currentId).then(() => next && getLyrics(next));
  });
  const lyr = $('#lyrics');
  for (const ev of ['wheel', 'touchmove']) lyr.addEventListener(ev, () => { lyricsUserScroll = Date.now(); }, { passive: true });
  player.audio.addEventListener('durationchange', renderTime);
  let countedFor = null;
  player.audio.addEventListener('timeupdate', () => {
    const key = `${player.currentId}:${player.token}`;
    if (!player.isSilent && player.audio.currentTime >= 30 && countedFor !== key) { countedFor = key; countPlay(player.currentId); }
  });
  player.audio.addEventListener('playing', () => {
    if (player.isSilent || !player.currentId) return;
    if (!preview.paused) preview.pause();
    markPlayed(player.currentId);
    addRecent(player.context || { type: 'track', id: player.currentId });
  });

  // Remember what was playing (song, position, queue) so the app picks up where you left off.
  let saveTimer;
  const savePlayer = (urgent = false) => {
    const snap = nowPlayingSnapshot();
    db.put('kv', snap, 'playerState');
    pushNowPlaying(snap, urgent); // share with your other devices
  };
  let lastId = null;
  player.addEventListener('change', () => {
    clearTimeout(saveTimer);
    const songChanged = player.currentId !== lastId;
    lastId = player.currentId;
    saveTimer = setTimeout(() => savePlayer(songChanged), 400);
  });
  let lastPosSave = 0;
  player.audio.addEventListener('timeupdate', () => {
    if (Date.now() - lastPosSave > 5000 && !player.isSilent) { lastPosSave = Date.now(); savePlayer(); }
  });
  player.audio.addEventListener('pause', () => savePlayer(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayer(true); });
  window.addEventListener('pagehide', () => savePlayer(true));

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
  state.artistPhotos = (await db.get('kv', 'artistPhotos')) || {};
  state.discover = (await db.get('kv', 'discover')) || null;
  state.inspo = (await db.get('kv', 'inspo')) || null;
  state.moodLists = (await db.get('kv', 'moodLists')) || null;
  discoverHidden = new Set((await db.get('kv', 'discoverHidden')) || []);
  tracks.forEach((t) => state.tracks.set(t.id, t));
  state.downloaded = new Set(blobKeys);
  if (playlists) state.playlists = playlists;
  if (settings) Object.assign(state.settings, settings);
  if (pending) Object.assign(state.pending, pending);
  np.device = (await db.get('kv', 'deviceId')) || '';
  if (!np.device) { np.device = Math.random().toString(36).slice(2, 12); db.put('kv', np.device, 'deviceId'); }
  if (playerState?.at) { np.at = playerState.at; np.pushedAt = playerState.at; np.sig = npSig(playerState); }

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

  setTimeout(analyzeLibrary, 3000);
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  sync();
}

init();
