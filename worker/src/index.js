// Selftape API — a Cloudflare Worker.
// Audio files live in Telegram (your "my music" channel), the track list and
// playlists live in a free Cloudflare D1 database, and it runs your private bot.
//
// Secrets (set with `npx wrangler secret put NAME`):
//   APP_TOKEN  – the password the app uses to talk to this server
//   BOT_TOKEN  – your Telegram bot token from @BotFather
// Vars (wrangler.toml):
//   ALLOWED_ORIGIN – your GitHub Pages origin (default "*")

const MAX_TG_BYTES = 20 * 1024 * 1024; // Telegram bots can only download files up to 20 MB
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|wav|wave|aif|aiff|flac|alac|caf|ogg|oga|opus|webm)$/i;
const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac', alac: 'audio/mp4',
  caf: 'audio/x-caf', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
};
const EXT_BY_MIME = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aiff': 'aiff', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/x-caf': 'caf' };

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      await ensureSchema(env);
      res = await route(request, env, ctx, new URL(request.url));
    } catch (err) {
      console.error(err);
      res = json({ error: err.message || 'Server error' }, err.status || 500);
    }
    res = new Response(res.body, res); // make headers mutable
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

async function route(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/' && method === 'GET') return new Response('Selftape API is running.');
  if (pathname === '/telegram' && method === 'POST') return telegramWebhook(request, env, ctx);

  // 30-second song previews (public: the audio player can't send the password)
  const pv = pathname.match(/^\/discover\/preview\/(\d{1,15})$/);
  if (pv && method === 'GET') return previewRedirect(pv[1]);

  if (!env.APP_TOKEN) return json({ error: 'APP_TOKEN is not set on the server' }, 500);
  if (!(await authorized(request, env))) return json({ error: 'Wrong app password' }, 401);

  if (pathname === '/library' && method === 'GET') return getLibrary(env);
  if (pathname === '/playlists' && method === 'PUT') return putPlaylists(request, env);
  if (pathname === '/history' && method === 'POST') return postHistory(request, env);
  if (pathname === '/discover' && method === 'POST') return discover(request);
  if (pathname === '/discover/links' && method === 'POST') return discoverLinks(request);
  if (pathname === '/inspo' && method === 'POST') return playlistInspo(request);
  if (pathname === '/moods' && method === 'POST') return moodLists(request);
  if (pathname === '/telegram/setup' && method === 'POST') return setupTelegram(env, url);
  if (pathname === '/covers/find-missing' && method === 'POST') return findMissingCovers(env);
  if (pathname === '/genres/find-missing' && method === 'POST') return findMissingGenres(env);
  if (pathname === '/library/fix' && method === 'POST') return fixLibrary(request, env);
  if (pathname === '/artist-photos/find' && method === 'POST') return findArtistPhotos(request, env);
  if (pathname === '/artist-photo' && method === 'GET') return getArtistPhoto(url, env);
  if (pathname === '/artist-photo' && method === 'PUT') return setArtistPhoto(request, env);
  if (pathname === '/artist-photo/options' && method === 'GET') return artistPhotoOptions(url);

  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'tracks') {
    if (parts.length === 1 && method === 'POST') return uploadTrack(request, env);
    const id = parts[1] || '';
    if (!ID_RE.test(id)) return json({ error: 'Bad track id' }, 400);
    if (parts.length === 3 && parts[2] === 'audio' && method === 'GET') return getAudio(id, env);
    if (parts.length === 3 && parts[2] === 'cover' && method === 'GET') return getCover(id, env);
    if (parts.length === 3 && parts[2] === 'cover' && method === 'DELETE') return removeCover(id, env);
    if (parts.length === 4 && parts[2] === 'cover' && parts[3] === 'find' && method === 'POST') return findCoverFor(id, env);
    if (parts.length === 3 && parts[2] === 'lookup' && method === 'POST') return lookupOne(id, env);
    if (parts.length === 4 && parts[2] === 'cover' && parts[3] === 'options' && method === 'GET') return coverOptions(id, url, env);
    if (parts.length === 3 && parts[2] === 'cover' && method === 'PUT') return setCover(id, request, env);
    if (parts.length === 2 && method === 'PATCH') return updateTrack(id, request, env);
    if (parts.length === 2 && method === 'DELETE') {
      // Only removes it from Selftape; the Telegram message is left alone.
      await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }
  return json({ error: 'Not found' }, 404);
}

// ---------- database ----------

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'audio/mpeg', added_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT '',
      file_id TEXT NOT NULL, file_unique_id TEXT, chat_id TEXT, message_id INTEGER)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS tracks_file_unique ON tracks(file_unique_id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS plays (track_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (track_id, at))'),
  ]);
  // Columns added after the first release (ignore "duplicate column" errors).
  for (const col of ['cover_file_id TEXT', 'cover_url TEXT', 'cover_checked INTEGER', 'genre TEXT', 'genre_checked INTEGER', 'features TEXT',
    'orig_title TEXT', 'orig_artist TEXT', 'name_locked INTEGER', 'fix_checked INTEGER']) {
    try { await env.DB.prepare(`ALTER TABLE tracks ADD COLUMN ${col}`).run(); } catch {}
  }
  schemaReady = true;
}

async function getKV(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : fallback;
}

function setKV(env, key, value) {
  return env.DB.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}

const getTgConfig = (env) => getKV(env, 'telegram', { ownerIds: [] });

function insertTrack(env, t) {
  return env.DB.prepare(`INSERT INTO tracks (id, title, artist, duration, size, type, added_at, source, file_id, file_unique_id, chat_id, message_id, cover_file_id, cover_url, cover_checked, genre, genre_checked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .bind(t.id, t.title, t.artist || '', t.duration || 0, t.size || 0, t.type, t.addedAt, t.source,
      t.fileId, t.fileUniqueId || null, t.chatId != null ? String(t.chatId) : null, t.messageId ?? null,
      t.coverFileId || null, t.coverUrl || null, t.coverChecked ? 1 : null, t.genre || null)
    .run();
}

const getRow = (env, id) => env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(id).first();

const toTrack = (r) => ({
  id: r.id, title: r.title, artist: r.artist, duration: r.duration, size: r.size,
  type: r.type, addedAt: r.added_at, source: r.source,
  cover: coverKey(r),
  genre: r.genre || '',
  features: parseFeatures(r.features),
  origTitle: r.orig_title || '',
  origArtist: r.orig_artist ?? '',
});

function parseFeatures(f) {
  if (!f) return null;
  try { return typeof f === 'string' ? JSON.parse(f) : f; } catch { return null; }
}

// A short key that changes whenever the cover changes, so the app knows to refetch it.
function coverKey(r) {
  const src = r.cover_file_id || r.coverFileId || r.cover_url || r.coverUrl;
  if (!src) return null;
  let h = 0;
  for (const c of src) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

// ---------- library ----------

async function getLibrary(env) {
  const { results } = await env.DB.prepare('SELECT * FROM tracks ORDER BY added_at DESC').all();
  const playlists = await getKV(env, 'playlists', { updatedAt: 0, items: [] });
  let libraryId = await getKV(env, 'libraryId', null);
  if (!libraryId) {
    libraryId = crypto.randomUUID();
    await setKV(env, 'libraryId', libraryId);
  }
  const cfg = await getTgConfig(env);
  return json({
    libraryId,
    tracks: results.map(toTrack),
    playlists,
    telegram: { connected: !!(cfg.ownerIds || []).length, channel: cfg.channelTitle || null },
    artistPhotos: await getKV(env, 'artistPhotos', {}), // artist key -> photo url ('' = checked, none)
    ...(await getHistory(env)),
  });
}

// ---------- discover: new songs like the ones you play ----------
// For each of your favourite artists, Deezer's "similar artists" and their
// most popular songs. Everything plays as an official 30-second preview.
const deezer = (path) => fetch(`https://api.deezer.com${path}`).then((r) => r.json()).catch(() => ({}));

function dayRandom(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

async function discover(request) {
  const body = await request.json().catch(() => ({}));
  const seeds = (Array.isArray(body.seeds) ? body.seeds : []).map((x) => clean(x, 120)).filter(Boolean).slice(0, 6);
  const known = new Set((Array.isArray(body.known) ? body.known : []).map((x) => norm(x)).filter(Boolean));
  const hidden = new Set((Array.isArray(body.hidden) ? body.hidden : []).map(String));
  const rand = dayRandom(String(body.day || new Date().toISOString().slice(0, 10)));
  const isKnown = (name) => { const n = norm(name); return known.has(n) || [...known].some((k) => k.length >= 6 && similarity(k, n) >= 0.85); };

  // 1) find your artists on Deezer
  const found = await Promise.all(seeds.map(async (name) => {
    const r = await deezer(`/search/artist?limit=3&q=${encodeURIComponent(name)}`);
    const a = (r.data || []).find((x) => similarity(norm(x.name), norm(name)) >= 0.75);
    return a ? { name, id: a.id } : null;
  }));
  const bases = found.filter(Boolean);

  // 2) their similar artists you don't have yet (each only once)
  const used = new Set();
  const picks = [];
  const related = await Promise.all(bases.map((b) => deezer(`/artist/${b.id}/related?limit=12`)));
  bases.forEach((b, i) => {
    const list = (related[i].data || []).filter((a) => !used.has(a.id) && !isKnown(a.name));
    // mostly the closest matches, plus one a bit further out
    const chosen = [...list.slice(0, 3), ...(list.length > 3 ? [list[3 + Math.floor(rand() * (list.length - 3))]] : [])].slice(0, 4);
    for (const a of chosen) { used.add(a.id); picks.push({ because: b.name, artist: a }); }
  });

  // 3) two popular songs from each
  const tops = await Promise.all(picks.slice(0, 24).map((p) => deezer(`/artist/${p.artist.id}/top?limit=5`)));
  const groups = new Map();
  picks.slice(0, 24).forEach((p, i) => {
    const songs = (tops[i].data || []).filter((t) => t.preview && t.readable !== false && !hidden.has(String(t.id)));
    const two = songs.sort(() => rand() - 0.5).slice(0, 2);
    if (!groups.has(p.because)) groups.set(p.because, []);
    for (const t of two) {
      groups.get(p.because).push({
        id: String(t.id),
        title: t.title_short || t.title,
        artist: t.artist?.name || p.artist.name,
        cover: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || '',
        duration: Number(t.duration) || 0,
        link: t.link || '',
      });
    }
  });
  return json({
    groups: [...groups].map(([because, tracks]) => ({ because, tracks: tracks.sort(() => rand() - 0.5) })).filter((g) => g.tracks.length),
  });
}

// Popular public playlists (from Deezer) for your artists, genres and moods,
// with their song lists. The app rebuilds them out of your own songs.
async function playlistInspo(request) {
  const body = await request.json().catch(() => ({}));
  const queries = (Array.isArray(body.queries) ? body.queries : []).map((q) => clean(q, 80)).filter(Boolean).slice(0, 9);
  const seen = new Set();
  const lists = [];
  const results = await Promise.all(queries.map((q) => deezer(`/search/playlist?limit=6&q=${encodeURIComponent(q)}`)));
  results.forEach((r, i) => {
    const good = (r.data || [])
      .filter((p) => !seen.has(p.id) && p.nb_tracks >= 15 && p.nb_tracks <= 400)
      .slice(0, 3);
    for (const p of good) { seen.add(p.id); lists.push({ id: String(p.id), title: clean(p.title, 80), query: queries[i], picture: p.picture_medium || '' }); }
  });
  const chosen = lists.slice(0, 27);
  const tracks = await Promise.all(chosen.map((p) => deezer(`/playlist/${p.id}/tracks?limit=150`)));
  return json({
    playlists: chosen.map((p, i) => ({
      ...p,
      tracks: (tracks[i].data || []).map((t) => [t.title_short || t.title || '', t.artist?.name || '']).filter((x) => x[0]),
    })).filter((p) => p.tracks.length >= 10),
  });
}

// What real mood playlists ("sad songs", "rainy day"…) are made of: their
// songs and how often each artist shows up. The app uses it to make its own
// mood mixes feel like the ones on Spotify.
async function moodLists(request) {
  const body = await request.json().catch(() => ({}));
  // each mood: one or two searches (e.g. "sad songs" and "sad songs rock" for your taste)
  const moods = Object.entries(body.moods || {}).slice(0, 10)
    .map(([id, q]) => [clean(id, 30), (Array.isArray(q) ? q : [q]).map((x) => clean(x, 60)).filter(Boolean).slice(0, 2)])
    .filter(([id, qs]) => id && qs.length);
  const searches = moods.flatMap(([id, qs]) => qs.map((q) => ({ id, q })));
  const found = await Promise.all(searches.map(({ q }) => deezer(`/search/playlist?limit=12&q=${encodeURIComponent(q)}`)));
  const jobs = [];
  const editorial = (x) => (/deezer/i.test(x.user?.name || '') ? 0 : 1); // Deezer's own playlists first
  for (const [id] of moods) {
    const per = searches.map((x, i) => (x.id === id ? (found[i].data || []).filter((p) => p.nb_tracks >= 20).sort((a, b) => editorial(a) - editorial(b)) : null)).filter(Boolean);
    const seen = new Set();
    for (let k = 0; k < 4 && jobs.filter((j) => j.id === id).length < 3; k++) {
      for (const list of per) {
        const p = list[k];
        if (p && !seen.has(p.id) && jobs.filter((j) => j.id === id).length < 3) { seen.add(p.id); jobs.push({ id, pid: p.id }); }
      }
    }
  }
  const lists = await Promise.all(jobs.slice(0, 40).map((j) => deezer(`/playlist/${j.pid}/tracks?limit=120`)));
  const out = {};
  jobs.slice(0, 40).forEach((j, i) => {
    const tracks = lists[i].data || [];
    const per = {};
    for (const t of tracks) { const a = t.artist?.name || ''; if (a) per[a] = (per[a] || 0) + 1; }
    if (!tracks.length || Math.max(0, ...Object.values(per)) > tracks.length * 0.25) return; // one-artist playlists say little about a mood
    const m = (out[j.id] ||= { songs: [], artists: {}, lists: 0 });
    m.lists++;
    for (const t of tracks) m.songs.push([t.title_short || t.title || '', t.artist?.name || '']);
    for (const a of Object.keys(per)) m.artists[a] = (m.artists[a] || 0) + 1; // = in how many playlists
  });
  return json({ moods: out });
}

// The preview links expire after a while, so get a fresh one each time.
async function previewRedirect(id) {
  const t = await deezer(`/track/${id}`);
  if (!t.preview) return new Response('No preview', { status: 404 });
  return Response.redirect(t.preview, 302);
}

// Apple Music links for a list of songs (so the button opens the right song).
async function discoverLinks(request) {
  const body = await request.json().catch(() => ({}));
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 20);
  const links = {};
  await Promise.all(items.map(async (it) => {
    const title = clean(it.title, 200);
    const artist = clean(it.artist, 200);
    if (!it.id || !title) return;
    try {
      const r = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${encodeURIComponent(`${artist} ${title}`)}`).then((x) => x.json());
      const hit = (r.results || []).find((x) => similarity(norm(x.trackName), norm(title)) >= 0.7 && similarity(norm(x.artistName), norm(artist)) >= 0.6);
      if (hit?.trackViewUrl) links[String(it.id)] = hit.trackViewUrl.replace(/[?&]uo=\d+/, '');
    } catch {}
  }));
  return json({ links });
}

// ---------- listening history (shared by all your devices) ----------
const RECENT_MAX = 12;
const PLAYS_DAYS = 120;

function mergeRecent(a, b) {
  const seen = new Set();
  return [...a, ...b]
    .filter((r) => r && r.type && r.id && Number(r.at))
    .sort((x, y) => y.at - x.at)
    .filter((r) => { const k = `${r.type}:${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, RECENT_MAX)
    .map((r) => ({ type: String(r.type), id: String(r.id), at: Number(r.at) }));
}

async function getHistory(env) {
  const since = Date.now() - PLAYS_DAYS * 86400e3;
  const { results } = await env.DB.prepare('SELECT track_id, at FROM plays WHERE at > ? ORDER BY at').bind(since).all();
  const plays = {};
  for (const r of results) (plays[r.track_id] ||= []).push(r.at);
  return { recent: await getKV(env, 'recent', []), plays, nowPlaying: await getKV(env, 'nowPlaying', null) };
}

// Where you left off (song, second, queue) - the newest device wins.
function cleanNowPlaying(np) {
  if (!np || typeof np !== 'object' || !Array.isArray(np.queue)) return null;
  const queue = np.queue.map(String).filter((t) => ID_RE.test(t)).slice(0, 5000);
  const index = Number(np.index);
  if (!queue.length || !(index >= 0 && index < queue.length) || queue.length !== np.queue.length) return null;
  const original = Array.isArray(np.original) ? np.original.map(String).filter((t) => ID_RE.test(t)).slice(0, 5000) : queue;
  const ctx = np.context && typeof np.context === 'object' ? { type: String(np.context.type || ''), id: String(np.context.id || '') } : null;
  return {
    queue, original, index, shuffle: !!np.shuffle, repeat: ['off', 'all', 'one'].includes(np.repeat) ? np.repeat : 'off',
    context: ctx, time: Math.max(0, Number(np.time) || 0), at: Number(np.at) || Date.now(), device: String(np.device || '').slice(0, 40),
  };
}

// A device sends its new plays and its "recently played" list; the server merges them.
async function postHistory(request, env) {
  const body = await request.json().catch(() => ({}));
  const plays = (Array.isArray(body.plays) ? body.plays : []).slice(0, 500)
    .filter((p) => ID_RE.test(String(p.id || '')) && Number(p.at) > 0);
  if (plays.length) {
    await env.DB.batch(plays.map((p) => env.DB.prepare('INSERT OR IGNORE INTO plays (track_id, at) VALUES (?, ?)').bind(String(p.id), Number(p.at))));
  }
  let recent = await getKV(env, 'recent', []);
  if (Array.isArray(body.recent) && body.recent.length) {
    recent = mergeRecent(body.recent, recent);
    await setKV(env, 'recent', recent);
  }
  let nowPlaying = null;
  const np = cleanNowPlaying(body.nowPlaying);
  if (np) {
    const cur = await getKV(env, 'nowPlaying', null);
    if (!cur || np.at >= cur.at) await setKV(env, 'nowPlaying', np);
    nowPlaying = !cur || np.at >= cur.at ? np : cur;
  }
  // keep the table small
  await env.DB.prepare('DELETE FROM plays WHERE at < ?').bind(Date.now() - PLAYS_DAYS * 86400e3).run();
  return json({ ok: true, recent, nowPlaying });
}

async function putPlaylists(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items)) return json({ error: 'Bad playlists' }, 400);
  const data = {
    updatedAt: Number(body.updatedAt) || Date.now(),
    items: body.items.map((p) => ({
      id: String(p.id),
      name: clean(p.name, 200) || 'Playlist',
      trackIds: Array.isArray(p.trackIds) ? p.trackIds.map(String).filter((t) => ID_RE.test(t)) : [],
      createdAt: Number(p.createdAt) || Date.now(),
    })),
  };
  await setKV(env, 'playlists', data);
  return json({ ok: true, updatedAt: data.updatedAt });
}

// ---------- tracks ----------

// Upload from the app: the file goes into your Telegram channel (or your chat with the bot).
async function uploadTrack(request, env) {
  const h = request.headers;
  const id = h.get('x-id') || crypto.randomUUID();
  if (!ID_RE.test(id)) return json({ error: 'Bad track id' }, 400);

  const existing = await getRow(env, id);
  if (existing) return json(toTrack(existing)); // retry of an upload that already worked

  const cfg = await getTgConfig(env);
  const target = cfg.channelId || (cfg.ownerIds || [])[0];
  if (!env.BOT_TOKEN || !target) return json({ error: 'Connect the Telegram bot first (Settings → Connect bot)' }, 409);

  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'Empty upload' }, 411);
  if (buf.byteLength > MAX_TG_BYTES) return json({ error: 'Too big for Telegram storage (20 MB max)' }, 413);

  const title = clean(dec(h.get('x-title'))) || 'Untitled';
  const artist = clean(dec(h.get('x-artist')), 60);
  const type = (h.get('content-type') || 'audio/mpeg').split(';')[0];
  const duration = Number(h.get('x-duration')) || 0;
  const filename = clean(dec(h.get('x-filename')), 200) || `${title}.${EXT_BY_MIME[type] || 'mp3'}`;

  const asAudio = /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac)$/.test(type);
  const form = new FormData();
  form.append('chat_id', String(target));
  form.append(asAudio ? 'audio' : 'document', new Blob([buf], { type }), filename);
  form.append('disable_notification', 'true');
  if (asAudio) {
    form.append('title', title);
    if (artist) form.append('performer', artist);
    if (duration) form.append('duration', String(Math.round(duration)));
  }
  const msg = await tg(env, asAudio ? 'sendAudio' : 'sendDocument', form);
  const file = msg.audio || msg.document || msg.voice;
  if (!file) throw new Error('Telegram did not store the file');

  const track = {
    id, title, artist, duration, type,
    size: file.file_size || buf.byteLength,
    addedAt: Number(h.get('x-added-at')) || Date.now(),
    source: 'app',
    fileId: file.file_id, fileUniqueId: file.file_unique_id,
    chatId: target, messageId: msg.message_id,
    coverFileId: file.thumbnail?.file_id || null,
  };
  await insertTrack(env, track);
  const fixed = await fixTrack(env, await getRow(env, id), { rename: true });
  return json(toTrack(fixed.row));
}

async function getAudio(id, env) {
  const row = await getRow(env, id);
  if (!row) return json({ error: 'Not found' }, 404);
  const info = await tg(env, 'getFile', { file_id: row.file_id });
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
  if (!res.ok) return json({ error: `Telegram download failed (${res.status})` }, 502);
  const headers = { 'content-type': row.type || 'audio/mpeg', 'cache-control': 'private, no-store' };
  const len = res.headers.get('content-length');
  if (len) headers['content-length'] = len;
  return new Response(res.body, { headers });
}

async function updateTrack(id, request, env) {
  const body = await request.json().catch(() => ({}));
  const row = await getRow(env, id);
  if (!row) return json({ error: 'Not found' }, 404);
  if (body.restore && row.orig_title) {
    // undo an automatic name fix
    await env.DB.prepare('UPDATE tracks SET title = ?, artist = ?, orig_title = NULL, orig_artist = NULL, name_locked = 1 WHERE id = ?')
      .bind(row.orig_title, row.orig_artist || '', id).run();
    return json(toTrack(await getRow(env, id)));
  }
  if (body.title !== undefined || body.artist !== undefined) {
    // you edited the name yourself: never rename this song automatically again
    await env.DB.prepare('UPDATE tracks SET name_locked = 1 WHERE id = ?').bind(id).run();
  }
  const title = clean(body.title) || row.title;
  const artist = body.artist !== undefined ? clean(body.artist, 60) : row.artist;
  const duration = !row.duration && Number(body.duration) ? Number(body.duration) : row.duration;
  const genre = body.genre !== undefined ? clean(body.genre, 40) : row.genre;
  let features = row.features;
  if (body.features && typeof body.features === 'object') features = JSON.stringify(body.features).slice(0, 500);
  await env.DB.prepare('UPDATE tracks SET title = ?, artist = ?, duration = ?, genre = ?, genre_checked = 1, features = ? WHERE id = ?')
    .bind(title, artist, duration, genre || null, features || null, id).run();
  return json(toTrack({ ...row, title, artist, duration, genre, features }));
}

// ---------- cover art ----------

async function getCover(id, env) {
  const row = await getRow(env, id);
  if (!row || (!row.cover_file_id && !row.cover_url)) return json({ error: 'No cover' }, 404);
  let res;
  if (row.cover_file_id) {
    const info = await tg(env, 'getFile', { file_id: row.cover_file_id });
    res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
  } else {
    res = await fetch(row.cover_url);
  }
  if (!res.ok) return json({ error: `Cover download failed (${res.status})` }, 502);
  return new Response(res.body, {
    headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=86400' },
  });
}

async function removeCover(id, env) {
  await env.DB.prepare('UPDATE tracks SET cover_file_id = NULL, cover_url = NULL, cover_checked = 1 WHERE id = ?').bind(id).run();
  const row = await getRow(env, id);
  return row ? json(toTrack(row)) : json({ error: 'Not found' }, 404);
}

async function findCoverFor(id, env) {
  const row = await getRow(env, id);
  if (!row) return json({ error: 'Not found' }, 404);
  const url = await lookupCover(row.artist, row.title);
  if (!url) {
    return json({ error: `No matching cover found for “${row.title}”${row.artist ? '' : ' (add the artist name first)'}` }, 404);
  }
  await env.DB.prepare('UPDATE tracks SET cover_url = ?, cover_file_id = NULL, cover_checked = 1 WHERE id = ?').bind(url, id).run();
  return json(toTrack({ ...row, cover_url: url, cover_file_id: null }));
}

// Checks a batch of tracks that never had a cover lookup; the app calls this until remaining is 0.
async function findMissingCovers(env) {
  const where = 'cover_file_id IS NULL AND cover_url IS NULL AND cover_checked IS NULL';
  const { results } = await env.DB.prepare(`SELECT id, title, artist FROM tracks WHERE ${where} LIMIT 6`).all();
  let found = 0;
  for (const r of results) {
    const url = await lookupCover(r.artist, r.title).catch(() => null);
    if (url) found++;
    await env.DB.prepare('UPDATE tracks SET cover_url = ?, cover_checked = 1 WHERE id = ?').bind(url, r.id).run();
  }
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${where}`).first();
  return json({ checked: results.length, found, remaining: left.n });
}

// Fills in genres for songs added before genres existed (the app calls this until remaining is 0).
// Look one song up again (after you fixed its title/artist): fills in the genre,
// and the cover too if it has none. Nothing you set yourself is overwritten.
async function lookupOne(id, env) {
  const row = await getRow(env, id);
  if (!row) return json({ error: 'Not found' }, 404);
  const r = await fixTrack(env, row, { rename: true });
  return json({ track: toTrack(r.row), matched: r.matched, retry: r.retry, renamed: r.renamed });
}

// Look a song up and fill in what's missing: genre, cover, and (if it's not a
// name you typed yourself) the official title + artist. Returns what changed.
async function fixTrack(env, row, { rename = true } = {}) {
  const m = await lookupMatch(row.artist, row.title).catch(() => ({ retry: true }));
  const out = { row: { ...row }, matched: !!m?.art, retry: !!m?.retry, renamed: null, gotGenre: false, gotCover: false };
  const r = out.row;
  if (m?.title && rename && !row.name_locked
      && (norm(m.title) !== norm(row.title) || norm(m.artist) !== norm(row.artist))) {
    out.renamed = { from: `${row.title}${row.artist ? ` · ${row.artist}` : ''}`, to: `${m.title} · ${m.artist}` };
    r.orig_title = row.orig_title || row.title;
    r.orig_artist = row.orig_title ? row.orig_artist : row.artist || '';
    r.title = clean(m.title) || row.title;
    r.artist = clean(m.artist, 60);
  }
  if (!r.genre && m?.genre) { r.genre = m.genre; out.gotGenre = true; }
  if (!r.cover_file_id && !r.cover_url && m?.art) { r.cover_url = m.art; out.gotCover = true; }
  await env.DB.prepare(`UPDATE tracks SET title = ?, artist = ?, orig_title = ?, orig_artist = ?, genre = ?, cover_url = ?,
      cover_checked = 1, genre_checked = ?, fix_checked = ? WHERE id = ?`)
    .bind(r.title, r.artist || '', r.orig_title || null, r.orig_title ? r.orig_artist || '' : null, r.genre || null, r.cover_url || null,
      out.retry ? null : 1,
      // only count the name as checked when this pass was allowed to fix names
      rename ? (out.retry ? null : 1) : row.fix_checked ?? null,
      row.id).run();
  return out;
}

// "Check & fix all songs": goes through the library a few songs at a time
// (the app keeps calling with `after` until done).
async function fixLibrary(request, env) {
  const body = await request.json().catch(() => ({}));
  const after = String(body.after || '');
  const rename = body.rename !== false;
  // onlyMissing: just the songs without a genre or a cover (the "problem" ones)
  const filter = body.onlyMissing ? "AND (genre IS NULL OR genre = '' OR (cover_file_id IS NULL AND (cover_url IS NULL OR cover_url = '')))" : '';
  const { results } = await env.DB.prepare(`SELECT * FROM tracks WHERE id > ? ${filter} ORDER BY id LIMIT 5`).bind(after).all();
  const report = { renamed: [], genres: 0, covers: 0, retry: 0 };
  for (const row of results) {
    const needs = !row.genre || (!row.cover_file_id && !row.cover_url) || (rename && !row.fix_checked && !row.name_locked);
    if (!needs) continue;
    const r = await fixTrack(env, row, { rename });
    if (r.renamed) report.renamed.push({ id: row.id, ...r.renamed });
    if (r.gotGenre) report.genres++;
    if (r.gotCover) report.covers++;
    if (r.retry) report.retry++;
  }
  const last = results[results.length - 1]?.id || after;
  return json({ after: last, done: results.length < 5, ...report });
}

async function findMissingGenres(env) {
  const where = 'genre_checked IS NULL';
  let retry = 0;
  const { results } = await env.DB.prepare(`SELECT id, title, artist FROM tracks WHERE ${where} LIMIT 6`).all();
  let found = 0;
  for (const r of results) {
    const full = await getRow(env, r.id);
    const res = await fixTrack(env, full, { rename: false });
    if (res.gotGenre) found++;
    if (res.retry) retry++; // Apple said "too many requests": it stays unchecked and is tried again later
  }
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${where}`).first();
  return json({ checked: results.length, found, retry, remaining: left.n });
}

// Cover choices for the picker in the app (you choose, so no strict matching).
async function coverOptions(id, url, env) {
  const row = await getRow(env, id);
  if (!row) return json({ error: 'Not found' }, 404);
  const q = clean(url.searchParams.get('q'), 200) || [row.artist, row.title].filter(Boolean).join(' ');
  const items = await searchCatalog(q, 30);
  return json({ query: q, options: items.slice(0, 24) });
}

async function setCover(id, request, env) {
  const body = await request.json().catch(() => ({}));
  let host = '';
  try { host = new URL(body.url).hostname; } catch {}
  // Only accept artwork from the two catalogues the picker shows.
  if (!/(^|\.)mzstatic\.com$|(^|\.)dzcdn\.net$/.test(host)) return json({ error: 'Unsupported image' }, 400);
  await env.DB.prepare('UPDATE tracks SET cover_url = ?, cover_file_id = NULL, cover_checked = 1 WHERE id = ?').bind(body.url, id).run();
  const row = await getRow(env, id);
  return row ? json(toTrack(row)) : json({ error: 'Not found' }, 404);
}

// ---------- artist photos (from Deezer) ----------

const artistKeyOf = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
const realPhoto = (u) => u && !/\/artist\/\/|\/images\/artist\/\//.test(u) ? u : ''; // Deezer's "no photo" placeholder

// The app sends artists it has no answer for yet, with a few of your song titles.
// A photo is only used when Deezer has an artist with that name AND one of your
// songs by them, so your own name doesn't get a stranger's photo.
async function findArtistPhotos(request, env) {
  const body = await request.json().catch(() => ({}));
  const list = (Array.isArray(body.artists) ? body.artists : []).slice(0, 8);
  const photos = await getKV(env, 'artistPhotos', {});
  const results = {};
  await Promise.all(list.map(async ({ name, titles }) => {
    const key = artistKeyOf(name);
    if (!key || key in photos) return;
    const url = await lookupArtistPhoto(name, Array.isArray(titles) ? titles.slice(0, 8) : []).catch(() => '');
    results[key] = url || '';
  }));
  Object.assign(photos, results);
  await setKV(env, 'artistPhotos', photos);
  return json({ photos: results });
}

async function lookupArtistPhoto(name, titles) {
  const na = norm(name);
  const nts = titles.map(norm).filter(Boolean);
  if (!na || !nts.length) return '';
  const nameOk = (x) => { const n = norm(x); return n === na || similarity(n, na) >= 0.85; };
  const titleOk = (x) => { const n = norm(x); return nts.some((t) => n === t || similarity(n, t) >= 0.8 || n.startsWith(t + ' ')); };
  // Search "artist + song" for up to 3 of your songs at once; the first real match wins.
  const lists = await Promise.all(titles.slice(0, 3).map((t) =>
    fetch(`https://api.deezer.com/search?limit=15&q=${encodeURIComponent(`${name} ${t}`)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => d.data || [])
      .catch(() => [])));
  const hit = lists.flat().find((r) => r.artist && nameOk(r.artist.name) && titleOk(r.title) && realPhoto(r.artist.picture_xl));
  return hit ? hit.artist.picture_xl : '';
}

async function getArtistPhoto(url, env) {
  const key = artistKeyOf(url.searchParams.get('name'));
  const photos = await getKV(env, 'artistPhotos', {});
  if (!photos[key]) return json({ error: 'No photo' }, 404);
  const res = await fetch(photos[key]);
  if (!res.ok) return json({ error: `Photo download failed (${res.status})` }, 502);
  return new Response(res.body, {
    headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=86400' },
  });
}

// You pick the photo in the app ('' = no photo, use a song cover instead).
async function setArtistPhoto(request, env) {
  const body = await request.json().catch(() => ({}));
  const key = artistKeyOf(body.name);
  if (!key) return json({ error: 'Missing artist' }, 400);
  let photo = '';
  if (body.url) {
    let host = '';
    try { host = new URL(body.url).hostname; } catch {}
    if (!/(^|\.)dzcdn\.net$|(^|\.)mzstatic\.com$/.test(host)) return json({ error: 'Unsupported image' }, 400);
    photo = body.url;
  }
  const photos = await getKV(env, 'artistPhotos', {});
  photos[key] = photo;
  await setKV(env, 'artistPhotos', photos);
  return json({ key, url: photo });
}

async function artistPhotoOptions(url) {
  const q = clean(url.searchParams.get('q'), 120);
  if (!q) return json({ options: [] });
  const res = await fetch(`https://api.deezer.com/search/artist?limit=24&q=${encodeURIComponent(q)}`);
  const data = res.ok ? await res.json() : {};
  const options = (data.data || [])
    .filter((a) => realPhoto(a.picture_xl))
    .map((a) => ({ title: a.name, artist: `${(a.nb_fan || 0).toLocaleString('en')} fans`, art: a.picture_xl }));
  return json({ query: q, options });
}

// Searches Apple Music (iTunes Search) and Deezer, both free with no key.
// Returns [{ title, artist, album, art }] with 600px artwork, duplicates removed.
async function searchCatalog(query, limit = 25, { itunes = true, deezer = true, status = {} } = {}) {
  const jobs = [];
  if (itunes) {
    jobs.push(fetch(`https://itunes.apple.com/search?entity=song&limit=${limit}&term=${encodeURIComponent(query)}`)
      .then((r) => { if (!r.ok) status.itunesFailed = true; return r.ok ? r.json() : { results: [] }; })
      .then((d) => (d.results || []).filter((r) => r.artworkUrl100).map((r, rank) => ({
        src: 'apple', rank,
        title: r.trackName, artist: r.artistName, album: r.collectionName,
        art: r.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'),
        genre: r.primaryGenreName || '',
      })))
      .catch(() => { status.itunesFailed = true; return []; }));
  }
  if (deezer) {
    jobs.push(fetch(`https://api.deezer.com/search?limit=${Math.min(limit, 50)}&q=${encodeURIComponent(query)}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => (d.data || []).filter((r) => r.album?.cover_xl).map((r, rank) => ({
        src: 'deezer', rank,
        title: r.title, artist: r.artist?.name || '', album: r.album?.title || '', art: r.album.cover_xl,
        deezerAlbum: r.album?.id,
      })))
      .catch(() => []));
  }
  const seen = new Set();
  return (await Promise.all(jobs)).flat().filter((x) => (seen.has(x.art) ? false : seen.add(x.art)));
}

// Automatic lookup. Small differences are fine ("sweet child of mine" finds
// "Sweet Child O' Mine", "guns and roses" finds "Guns N' Roses"), but both the
// artist AND the title must be close, so unreleased songs don't get a random cover.
async function lookupCover(artist, title) {
  return (await lookupMatch(artist, title))?.art || null; // null when nothing matched
}

// Smart lookup: compares *words*, not exact strings, so it copes with typos,
// swapped title/artist, a missing artist, and junk like "official video" or
// track numbers. It still says "no idea" when results are unrelated (e.g. your
// own unreleased songs). Returns { title, artist, art, genre } or null.
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'feat', 'ft', 'featuring', 'official', 'audio', 'video', 'music', 'lyrics',
  'lyric', 'hd', 'hq', 'mp3', 'remastered', 'remaster', 'version', 'original', 'full', 'song', 'by', 'prod', 'visualizer']);
const matchWords = (s) => norm(s).split(' ').filter((w) => w && !STOP_WORDS.has(w) && !/^\d{1,2}$/.test(w));
const VERSION_WORDS = /\b(remix|mix|live|acoustic|instrumental|karaoke|sped up|slowed|reverb|cover|version|edit|demo|tribute)\b/i;
const cleanTitle = (t) => String(t || '')
  .replace(/\s*[-–]\s*(\d{4}\s+)?remaster(ed)?(\s+\d{4})?(\s+version)?\s*$/i, '')
  .replace(/\s*[([](\d{4}\s+)?remaster(ed)?[^)\]]*[)\]]/i, '')
  .trim();

async function lookupMatch(artist, title) {
  const query = `${artist || ''} ${title || ''}`.trim();
  const q = matchWords(query);
  if (!q.length) return null;
  const wantsVersion = VERSION_WORDS.test(query);

  const evaluate = (c) => {
    if (!wantsVersion && VERSION_WORDS.test(String(c.title || ''))) return null;
    const tw = matchWords(c.title);
    const aw = matchWords(c.artist);
    if (!tw.length) return null;
    const used = new Set();
    const hit = (w) => {
      const j = q.findIndex((x, i) => !used.has(i) && (x === w || (x.length >= 3 && w.length >= 3 && similarity(x, w) >= (Math.min(x.length, w.length) <= 4 ? 0.75 : 0.8))));
      if (j >= 0) { used.add(j); return true; }
      return false;
    };
    const titleCov = tw.filter(hit).length / tw.length;
    const artistCov = aw.length ? aw.filter(hit).length / aw.length : 0;
    const queryCov = used.size / q.length;
    return { c, titleCov, artistCov, queryCov, score: titleCov * 2 + artistCov + queryCov - c.rank * 0.02 };
  };

  const status = {};
  let cands = await searchCatalog(query, 15, { status });
  const pick = (list) => {
    const rated = list.map(evaluate).filter(Boolean);
    // 1) title and artist both there (any order, small typos OK)
    const full = rated.filter((r) => r.titleCov >= 0.75 && r.artistCov >= 0.5 && r.queryCov >= 0.6);
    if (full.length) return full.sort((a, b) => b.score - a.score)[0];
    // 2) only a title (no or wrong artist): Apple and Deezer must agree on the same song near the top,
    //    or the title must be long and specific (4+ words)
    const titleOnly = rated.filter((r) => r.titleCov === 1 && r.queryCov >= 0.8 && r.c.rank <= 2);
    for (const r of titleOnly.sort((a, b) => b.score - a.score)) {
      const t = norm(r.c.title);
      const a = norm(r.c.artist);
      const agree = titleOnly.some((o) => o.c.src !== r.c.src && norm(o.c.title) === t && (norm(o.c.artist).includes(a) || a.includes(norm(o.c.artist))));
      if (agree || matchWords(r.c.title).length >= 4) return r;
    }
    return null;
  };
  let best = pick(cands);
  if (!best && artist) {
    // maybe the "artist" is wrong or is really part of the title: try the title alone
    const more = await searchCatalog(title, 15, { status });
    cands = cands.concat(more);
    best = pick(more);
  }
  if (!best && artist && title) {
    // typos in the title: look through the artist's own songs
    const byArtist = await searchCatalog(artist, 50, { status });
    cands = cands.concat(byArtist);
    best = pick(byArtist);
  }
  if (!best) return status.itunesFailed ? { art: null, genre: '', retry: true } : null;

  const b = best.c;
  const same = (c) => norm(cleanTitle(c.title)) === norm(cleanTitle(b.title)) && norm(c.artist) === norm(b.artist)
    && (wantsVersion || !VERSION_WORDS.test(String(c.title || '')));
  let genre = b.genre || cands.find((c) => c.genre && same(c))?.genre || '';
  if (!genre) {
    const albumId = b.deezerAlbum || cands.find((c) => c.deezerAlbum && same(c))?.deezerAlbum;
    if (albumId) {
      genre = await fetch(`https://api.deezer.com/album/${albumId}`)
        .then((r) => (r.ok ? r.json() : {}))
        .then((d) => d.genres?.data?.[0]?.name || '')
        .catch(() => '');
    }
  }
  // prefer Apple's spelling/cover when both catalogues have the song
  const apple = b.src === 'apple' ? b : cands.find((c) => c.src === 'apple' && same(c));
  return { title: cleanTitle((apple || b).title), artist: (apple || b).artist, art: (apple || b).art, genre, retry: !genre && status.itunesFailed };
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // (feat. …), [Remastered]
    .replace(/\s(feat|ft)\.?\s.*$/, ' ')
    .replace(/[’'`]/g, '')           // O' Mine -> O Mine
    .replace(/&|\+/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(n|and)\b/g, 'and')   // Guns N' Roses == Guns and Roses
    .replace(/^the /, '')
    .trim();
}

// 0..1, how alike two strings are (1 = identical), based on edit distance.
function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// ---------- telegram ----------

async function setupTelegram(env, url) {
  if (!env.BOT_TOKEN) return json({ error: 'BOT_TOKEN is not set on the server' }, 400);
  const me = await tg(env, 'getMe', {});
  await tg(env, 'setWebhook', {
    url: `${url.origin}/telegram`,
    secret_token: await webhookSecret(env),
    allowed_updates: ['message', 'channel_post', 'my_chat_member'],
  });
  const cfg = await getTgConfig(env);
  cfg.claimCode = randomHex(16);
  cfg.claimExpires = Date.now() + 30 * 60 * 1000;
  await setKV(env, 'telegram', cfg);
  return json({
    ok: true,
    bot: me.username,
    link: `https://t.me/${me.username}?start=${cfg.claimCode}`,
    channel: cfg.channelTitle || null,
  });
}

async function telegramWebhook(request, env, ctx) {
  if (!env.APP_TOKEN || request.headers.get('x-telegram-bot-api-secret-token') !== (await webhookSecret(env))) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => null);
  if (update) {
    // Answer Telegram right away; do the work in the background.
    ctx.waitUntil(handleUpdate(update, env).catch((err) => console.error('bot error', err)));
  }
  return new Response('ok');
}

async function handleUpdate(update, env) {
  if (update.message) return handleMessage(update.message, env);
  if (update.channel_post) return handleChannelPost(update.channel_post, env);
  if (update.my_chat_member) return handleMembership(update.my_chat_member, env);
}

const ownerSet = (cfg) => new Set((cfg.ownerIds || []).map(String));

// Messages in your private chat with the bot.
async function handleMessage(msg, env) {
  if (msg.chat?.type !== 'private') return;
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id ?? '');
  const cfg = await getTgConfig(env);
  const text = (msg.text || '').trim();

  // Claim link from the app: /start <code>
  if (text.startsWith('/start ')) {
    const code = text.slice(7).trim();
    if (cfg.claimCode && code === cfg.claimCode && Date.now() < cfg.claimExpires) {
      cfg.ownerIds = [...new Set([...(cfg.ownerIds || []).map(String), userId])];
      cfg.claimCode = null;
      await setKV(env, 'telegram', cfg);
      return reply(env, chatId,
        "✅ Connected to Selftape!\n\n" +
        "Next: add me as an admin of your music channel (Channel → Administrators → Add admin → search for me). " +
        "After that, everything you post in the channel shows up in the app.\n\n" +
        "To add tracks that are already in the channel, forward them to me here.");
    }
  }

  if (!ownerSet(cfg).has(userId)) return reply(env, chatId, 'This is a private bot.');

  if (text === '/status') {
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM tracks').all();
    return reply(env, chatId, `🎧 ${results[0].n} tracks in Selftape.\n📻 Channel: ${cfg.channelTitle || 'not linked yet (add me as an admin of your channel)'}`);
  }

  try {
    const result = await addFromMessage(env, msg, cfg, { source: 'telegram', archive: true });
    if (!result) {
      return reply(env, chatId, "Send or forward me an audio file and I'll add it to Selftape. I use the song's own title and artist; a caption is only used if the file has no title.");
    }
    if (result.duplicate) return reply(env, chatId, `Already in Selftape: “${result.title}”`, msg.message_id);
    const who = result.artist ? ` · ${result.artist}` : '';
    const note = result.renamed ? `\n✏️ Fixed the name (was “${result.renamed.from}”)` : '';
    const genre = result.genre ? `\n🏷️ ${result.genre}` : '';
    return reply(env, chatId, `✅ Added “${result.title}”${who}${genre}${note}`, msg.message_id);
  } catch (err) {
    return reply(env, chatId, `⚠️ ${err.message}`, msg.message_id);
  }
}

// New posts in your linked channel.
async function handleChannelPost(post, env) {
  const cfg = await getTgConfig(env);
  if (!cfg.channelId || String(post.chat.id) !== String(cfg.channelId)) return;
  try {
    await addFromMessage(env, post, cfg, { source: 'channel', archive: false });
  } catch (err) {
    const name = pickAudio(post)?.file_name || 'a file';
    await notifyOwners(env, cfg, `⚠️ Couldn't add ${name} from “${cfg.channelTitle}”: ${err.message}`);
  }
}

// The bot was added to (or removed from) a channel.
async function handleMembership(upd, env) {
  if (upd.chat?.type !== 'channel') return;
  const cfg = await getTgConfig(env);
  const status = upd.new_chat_member?.status;
  const byOwner = ownerSet(cfg).has(String(upd.from?.id ?? ''));
  if (status === 'administrator' && byOwner) {
    cfg.channelId = String(upd.chat.id);
    cfg.channelTitle = upd.chat.title || 'your channel';
    await setKV(env, 'telegram', cfg);
    await notifyOwners(env, cfg,
      `📻 Linked to “${cfg.channelTitle}”. Anything you post there is added to Selftape.\n\n` +
      'To add tracks that are already in the channel: select them, tap Forward, and send them to me.');
  } else if ((status === 'left' || status === 'kicked') && String(upd.chat.id) === String(cfg.channelId)) {
    cfg.channelId = null;
    cfg.channelTitle = null;
    await setKV(env, 'telegram', cfg);
    await notifyOwners(env, cfg, '📻 I was removed from your channel, so it is no longer linked.');
  }
}

async function addFromMessage(env, msg, cfg, { source, archive }) {
  const file = pickAudio(msg);
  if (!file) return null;
  if (file.file_size && file.file_size > MAX_TG_BYTES) {
    throw new Error(`That file is ${(file.file_size / 1048576).toFixed(1)} MB. Telegram only lets bots download files up to 20 MB, so it can't be played in Selftape. Export it as MP3/M4A to make it smaller.`);
  }

  if (file.file_unique_id) {
    const dup = await env.DB.prepare('SELECT title FROM tracks WHERE file_unique_id = ?').bind(file.file_unique_id).first();
    if (dup) return { duplicate: true, title: dup.title };
  }

  let chatId = msg.chat.id;
  let messageId = msg.message_id;
  const origin = msg.forward_origin;
  const fromOwnChannel = origin?.type === 'channel' && cfg.channelId && String(origin.chat?.id) === String(cfg.channelId);
  if (fromOwnChannel) {
    // Forwarded from the channel: it's already archived there.
    chatId = origin.chat.id;
    messageId = origin.message_id;
  } else if (archive && cfg.channelId && !origin) {
    // Sent to the bot directly (not forwarded): keep a copy in the channel so
    // all your music lives in one place. Forwarded songs are never copied,
    // because you already have them somewhere (often in the channel itself).
    try {
      const copy = await tg(env, 'copyMessage', { chat_id: cfg.channelId, from_chat_id: msg.chat.id, message_id: msg.message_id, disable_notification: true });
      chatId = cfg.channelId;
      messageId = copy.message_id;
    } catch (err) {
      console.error('copy to channel failed', err);
    }
  }

  const name = file.file_name || '';
  const type = file.mime_type && file.mime_type !== 'application/octet-stream' ? file.mime_type : guessMime(name) || 'audio/mpeg';
  // The song's own tags win; the caption is only used when the file has no title.
  const title =
    clean(file.title) || clean(msg.caption) || clean(stripExt(name)) ||
    (file.kind === 'voice' ? `Voice memo ${new Date(msg.date * 1000).toISOString().slice(0, 16).replace('T', ' ')}` : 'Untitled');

  const artist = clean(file.performer, 60);
  const coverFileId = file.thumbnail?.file_id || file.thumb?.file_id || null;

  const newId = crypto.randomUUID();
  await insertTrack(env, {
    id: newId,
    title,
    artist,
    coverFileId,
    coverUrl: null,
    coverChecked: false,
    genre: null,
    duration: file.duration || 0,
    size: file.file_size || 0,
    type,
    addedAt: Date.now(),
    source,
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    chatId,
    messageId,
  });
  const fixed = await fixTrack(env, await getRow(env, newId), { rename: true });
  return { title: fixed.row.title, artist: fixed.row.artist, renamed: fixed.renamed, genre: fixed.row.genre };
}

function pickAudio(msg) {
  if (msg.audio) return { ...msg.audio, kind: 'audio' };
  if (msg.voice) return { ...msg.voice, kind: 'voice' };
  const d = msg.document;
  if (d && ((d.mime_type || '').startsWith('audio/') || AUDIO_EXT.test(d.file_name || ''))) return { ...d, kind: 'document' };
  return null;
}

async function tg(env, method, params) {
  const isForm = params instanceof FormData;
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'content-type': 'application/json' },
    body: isForm ? params : JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

function reply(env, chatId, text, replyTo) {
  const params = { chat_id: chatId, text };
  if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  return tg(env, 'sendMessage', params);
}

async function notifyOwners(env, cfg, text) {
  for (const id of cfg.ownerIds || []) await reply(env, id, text).catch(() => {});
}

async function webhookSecret(env) {
  return hex(await sha256('telegram-webhook:' + env.APP_TOKEN)).slice(0, 48);
}

// ---------- helpers ----------

async function authorized(request, env) {
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [a, b] = await Promise.all([sha256(token), sha256(env.APP_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// ALLOWED_ORIGIN can list several sites, comma separated.
function corsHeaders(env, request) {
  const allowed = String(env.ALLOWED_ORIGIN || '*').split(',').map((o) => o.trim()).filter(Boolean);
  const origin = request.headers.get('origin') || '';
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-id, x-title, x-artist, x-duration, x-added-at, x-filename',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function dec(s) {
  if (!s) return '';
  try { return decodeURIComponent(s); } catch { return s; }
}

function clean(s, max = 120) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const stripExt = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ');
const guessMime = (name) => MIME_BY_EXT[(String(name).split('.').pop() || '').toLowerCase()] || '';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
