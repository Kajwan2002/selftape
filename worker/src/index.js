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
    const cors = corsHeaders(env);
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

  if (!env.APP_TOKEN) return json({ error: 'APP_TOKEN is not set on the server' }, 500);
  if (!(await authorized(request, env))) return json({ error: 'Wrong app password' }, 401);

  if (pathname === '/library' && method === 'GET') return getLibrary(env);
  if (pathname === '/playlists' && method === 'PUT') return putPlaylists(request, env);
  if (pathname === '/telegram/setup' && method === 'POST') return setupTelegram(env, url);
  if (pathname === '/covers/find-missing' && method === 'POST') return findMissingCovers(env);

  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'tracks') {
    if (parts.length === 1 && method === 'POST') return uploadTrack(request, env);
    const id = parts[1] || '';
    if (!ID_RE.test(id)) return json({ error: 'Bad track id' }, 400);
    if (parts.length === 3 && parts[2] === 'audio' && method === 'GET') return getAudio(id, env);
    if (parts.length === 3 && parts[2] === 'cover' && method === 'GET') return getCover(id, env);
    if (parts.length === 3 && parts[2] === 'cover' && method === 'DELETE') return removeCover(id, env);
    if (parts.length === 4 && parts[2] === 'cover' && parts[3] === 'find' && method === 'POST') return findCoverFor(id, env);
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
  ]);
  // Columns added after the first release (ignore "duplicate column" errors).
  for (const col of ['cover_file_id TEXT', 'cover_url TEXT', 'cover_checked INTEGER']) {
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
  return env.DB.prepare(`INSERT INTO tracks (id, title, artist, duration, size, type, added_at, source, file_id, file_unique_id, chat_id, message_id, cover_file_id, cover_url, cover_checked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(t.id, t.title, t.artist || '', t.duration || 0, t.size || 0, t.type, t.addedAt, t.source,
      t.fileId, t.fileUniqueId || null, t.chatId != null ? String(t.chatId) : null, t.messageId ?? null,
      t.coverFileId || null, t.coverUrl || null, t.coverChecked ? 1 : null)
    .run();
}

const getRow = (env, id) => env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(id).first();

const toTrack = (r) => ({
  id: r.id, title: r.title, artist: r.artist, duration: r.duration, size: r.size,
  type: r.type, addedAt: r.added_at, source: r.source,
  cover: coverKey(r),
});

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
  });
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
  if (!track.coverFileId) {
    track.coverUrl = await lookupCover(artist, title).catch(() => null);
    track.coverChecked = true;
  }
  await insertTrack(env, track);
  return json(toTrack({ ...track, added_at: track.addedAt }));
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
  const title = clean(body.title) || row.title;
  const artist = body.artist !== undefined ? clean(body.artist, 60) : row.artist;
  const duration = !row.duration && Number(body.duration) ? Number(body.duration) : row.duration;
  await env.DB.prepare('UPDATE tracks SET title = ?, artist = ?, duration = ? WHERE id = ?').bind(title, artist, duration, id).run();
  return json(toTrack({ ...row, title, artist, duration }));
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

// Searches Apple Music (iTunes Search) and Deezer, both free with no key.
// Returns [{ title, artist, album, art }] with 600px artwork, duplicates removed.
async function searchCatalog(query, limit = 25, { itunes = true, deezer = true } = {}) {
  const jobs = [];
  if (itunes) {
    jobs.push(fetch(`https://itunes.apple.com/search?entity=song&limit=${limit}&term=${encodeURIComponent(query)}`)
      .then((r) => (r.ok ? r.json() : { results: [] }))
      .then((d) => (d.results || []).filter((r) => r.artworkUrl100).map((r) => ({
        title: r.trackName, artist: r.artistName, album: r.collectionName,
        art: r.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'),
      })))
      .catch(() => []));
  }
  if (deezer) {
    jobs.push(fetch(`https://api.deezer.com/search?limit=${Math.min(limit, 50)}&q=${encodeURIComponent(query)}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => (d.data || []).filter((r) => r.album?.cover_xl).map((r) => ({
        title: r.title, artist: r.artist?.name || '', album: r.album?.title || '', art: r.album.cover_xl,
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
  let a = artist;
  let t = title;
  if (!a && / - /.test(t)) [a, t] = t.split(/ - (.*)/s); // "Artist - Song" titles
  const na = norm(a);
  const nt = norm(t);
  if (!na || !nt) return null;

  // Versions we skip unless the title asks for them (so "Song" doesn't get the remix cover).
  const VERSION_WORDS = /\b(remix|mix|live|acoustic|instrumental|karaoke|sped up|slowed|reverb|cover|version|edit|demo)\b/;
  const wantsVersion = VERSION_WORDS.test(String(title || '').toLowerCase());

  const artistScore = (x) => {
    const n = norm(x);
    if (!n) return 0;
    if (n === na || n.includes(na) || na.includes(n)) return 1;
    return similarity(n, na);
  };
  const titleScore = (x) => {
    const n = norm(x);
    if (!n) return 0;
    if (n === nt) return 1;
    if (n.startsWith(nt + ' ') || nt.startsWith(n + ' ')) return 0.9;
    return similarity(n, nt);
  };
  const score = (c) => {
    if (!wantsVersion && VERSION_WORDS.test(String(c.title || '').toLowerCase())) return 0;
    const as = artistScore(c.artist);
    const ts = titleScore(c.title);
    return as >= 0.75 && ts >= 0.8 ? as + ts * 2 : 0; // title counts double
  };

  // Several searches at once: the exact words, a looser Deezer search, and the
  // artist's catalogue (catches misspelled titles) and the title alone (misspelled artist).
  const lists = await Promise.all([
    searchCatalog(`${a} ${t}`, 25),
    searchCatalog(a, 200, { deezer: false }),
    searchCatalog(t, 50, { deezer: false }),
  ]);
  let best = null;
  let bestScore = 0;
  for (const c of lists.flat()) {
    const sc = score(c);
    if (sc > bestScore) { best = c; bestScore = sc; }
  }
  return best?.art || null;
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
    return reply(env, chatId, `✅ Added “${result.title}”`, msg.message_id);
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
  } else if (archive && cfg.channelId) {
    // Keep a copy in the channel so all your music lives in one place.
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
  const coverUrl = coverFileId ? null : await lookupCover(artist, title).catch(() => null);

  await insertTrack(env, {
    id: crypto.randomUUID(),
    title,
    artist,
    coverFileId,
    coverUrl,
    coverChecked: true,
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
  return { title };
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

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
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
