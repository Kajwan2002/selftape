// Selftape API — a Cloudflare Worker that stores your music in R2,
// syncs playlists between devices, and runs your private Telegram bot.
//
// Secrets (set with `npx wrangler secret put NAME`):
//   APP_TOKEN  – the password the app uses to talk to this server
//   BOT_TOKEN  – your Telegram bot token from @BotFather
// Optional:
//   ALLOWED_ORIGIN  – lock the API to your GitHub Pages origin (default "*")
//   ALLOWED_USER_ID – extra Telegram user IDs allowed to use the bot (comma separated)

const MAX_BOT_BYTES = 20 * 1024 * 1024; // Telegram's limit for bot downloads
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|wav|wave|aif|aiff|flac|alac|caf|ogg|oga|opus|webm)$/i;
const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wave: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac', alac: 'audio/mp4',
  caf: 'audio/x-caf', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
};

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(request, env, ctx, new URL(request.url));
    } catch (err) {
      console.error(err);
      res = json({ error: err.message || 'Server error' }, 500);
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

  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'tracks') {
    if (parts.length === 1 && method === 'POST') return uploadTrack(request, env);
    const id = parts[1] || '';
    if (!ID_RE.test(id)) return json({ error: 'Bad track id' }, 400);
    if (parts.length === 3 && parts[2] === 'audio' && method === 'GET') return getAudio(id, env);
    if (parts.length === 2 && method === 'PATCH') return updateTrack(id, request, env);
    if (parts.length === 2 && method === 'DELETE') {
      await env.BUCKET.delete(audioKey(id));
      return json({ ok: true });
    }
  }
  return json({ error: 'Not found' }, 404);
}

// ---------- library ----------

async function getLibrary(env) {
  const objects = await listAll(env.BUCKET, 'audio/');
  const tracks = objects.map(toTrack);
  const pl = await env.BUCKET.get('playlists.json');
  const playlists = pl ? await pl.json() : { updatedAt: 0, items: [] };
  return json({ libraryId: await libraryId(env), tracks, playlists });
}

async function libraryId(env) {
  const obj = await env.BUCKET.get('library.json');
  if (obj) return (await obj.json()).id;
  const id = crypto.randomUUID();
  await putJson(env, 'library.json', { id, createdAt: Date.now() });
  return id;
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
  await putJson(env, 'playlists.json', data);
  return json({ ok: true, updatedAt: data.updatedAt });
}

// ---------- tracks ----------

async function uploadTrack(request, env) {
  const h = request.headers;
  const id = h.get('x-id') || crypto.randomUUID();
  if (!ID_RE.test(id)) return json({ error: 'Bad track id' }, 400);
  if (!Number(h.get('content-length'))) return json({ error: 'Empty upload' }, 411);
  const title = clean(dec(h.get('x-title'))) || 'Untitled';
  const artist = clean(dec(h.get('x-artist')), 60);
  const contentType = h.get('content-type') || 'audio/mpeg';
  const metadata = {
    title, artist,
    duration: String(Number(h.get('x-duration')) || 0),
    addedAt: String(Number(h.get('x-added-at')) || Date.now()),
    source: 'app',
  };
  const obj = await env.BUCKET.put(audioKey(id), request.body, {
    httpMetadata: { contentType },
    customMetadata: encodeMeta(metadata),
  });
  return json(toTrack(obj));
}

async function getAudio(id, env) {
  const obj = await env.BUCKET.get(audioKey(id));
  if (!obj) return json({ error: 'Not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'audio/mpeg',
      'content-length': String(obj.size),
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}

async function updateTrack(id, request, env) {
  const body = await request.json().catch(() => ({}));
  const obj = await env.BUCKET.get(audioKey(id));
  if (!obj) return json({ error: 'Not found' }, 404);
  const old = decodeMeta(obj.customMetadata);
  const next = {
    ...old,
    title: clean(body.title) || old.title || 'Untitled',
    artist: body.artist !== undefined ? clean(body.artist, 60) : old.artist || '',
    duration: !Number(old.duration) && Number(body.duration) ? String(Number(body.duration)) : old.duration || '0',
  };
  // R2 has no "update metadata" call, so rewrite the object with the new metadata.
  const { readable, writable } = new FixedLengthStream(obj.size);
  const pipe = obj.body.pipeTo(writable);
  const saved = await env.BUCKET.put(audioKey(id), readable, {
    httpMetadata: obj.httpMetadata,
    customMetadata: encodeMeta(next),
  });
  await pipe;
  return json(toTrack(saved));
}

// ---------- telegram ----------

async function setupTelegram(env, url) {
  if (!env.BOT_TOKEN) return json({ error: 'BOT_TOKEN is not set on the server' }, 400);
  const me = await tg(env, 'getMe', {});
  await tg(env, 'setWebhook', {
    url: `${url.origin}/telegram`,
    secret_token: await webhookSecret(env),
    allowed_updates: ['message'],
  });
  const cfg = await getTgConfig(env);
  cfg.claimCode = randomHex(16);
  cfg.claimExpires = Date.now() + 30 * 60 * 1000;
  await putJson(env, 'telegram.json', cfg);
  return json({
    ok: true,
    bot: me.username,
    link: `https://t.me/${me.username}?start=${cfg.claimCode}`,
    connectedUsers: (cfg.ownerIds || []).length,
  });
}

async function telegramWebhook(request, env, ctx) {
  if (!env.APP_TOKEN || request.headers.get('x-telegram-bot-api-secret-token') !== (await webhookSecret(env))) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => null);
  if (update?.message) {
    // Answer Telegram right away; do the download in the background.
    ctx.waitUntil(handleMessage(update.message, env).catch((err) => console.error('bot error', err)));
  }
  return new Response('ok');
}

async function handleMessage(msg, env) {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id != null ? String(msg.from.id) : '';
  if (!chatId || !userId) return;

  const cfg = await getTgConfig(env);
  const text = (msg.text || '').trim();

  // Claim link from the app: /start <code>
  if (text.startsWith('/start ')) {
    const code = text.slice(7).trim();
    if (cfg.claimCode && code === cfg.claimCode && Date.now() < cfg.claimExpires) {
      cfg.ownerIds = [...new Set([...(cfg.ownerIds || []), userId])];
      cfg.claimCode = null;
      await putJson(env, 'telegram.json', cfg);
      return reply(env, chatId, "✅ Connected! Send or forward me audio files and they'll show up in your library.\n\nTip: add a caption to set the title.");
    }
  }

  const extra = String(env.ALLOWED_USER_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  const owners = new Set([...(cfg.ownerIds || []), ...extra]);
  if (!owners.has(userId)) return reply(env, chatId, 'This is a private bot.');

  const file = pickAudio(msg);
  if (!file) {
    return reply(env, chatId, "Send or forward me an audio file and I'll add it to your library. Add a caption to set the title.");
  }
  if (file.file_size && file.file_size > MAX_BOT_BYTES) {
    const mb = (file.file_size / 1048576).toFixed(1);
    return reply(env, chatId, `That file is ${mb} MB. Telegram only lets bots download files up to 20 MB — save it to Files and use Import in the app instead.`, msg.message_id);
  }

  try {
    const info = await tg(env, 'getFile', { file_id: file.file_id });
    const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = await res.arrayBuffer();

    const name = file.file_name || String(info.file_path || '').split('/').pop() || '';
    const mime = file.mime_type && file.mime_type !== 'application/octet-stream' ? file.mime_type : guessMime(name) || 'audio/mpeg';
    const title =
      clean(msg.caption) || clean(file.title) || clean(stripExt(name)) ||
      (file.kind === 'voice' ? `Voice memo ${new Date(msg.date * 1000).toISOString().slice(0, 16).replace('T', ' ')}` : 'Untitled');

    await env.BUCKET.put(audioKey(crypto.randomUUID()), buf, {
      httpMetadata: { contentType: mime },
      customMetadata: encodeMeta({
        title,
        artist: clean(file.performer, 60),
        duration: String(file.duration || 0),
        addedAt: String(Date.now()),
        source: 'telegram',
      }),
    });
    await reply(env, chatId, `✅ Added “${title}”`, msg.message_id);
  } catch (err) {
    await reply(env, chatId, `⚠️ Couldn't add that: ${err.message}`, msg.message_id);
  }
}

function pickAudio(msg) {
  if (msg.audio) return { ...msg.audio, kind: 'audio' };
  if (msg.voice) return { ...msg.voice, kind: 'voice' };
  const d = msg.document;
  if (d && ((d.mime_type || '').startsWith('audio/') || AUDIO_EXT.test(d.file_name || ''))) return { ...d, kind: 'document' };
  return null;
}

async function tg(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
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

async function getTgConfig(env) {
  const obj = await env.BUCKET.get('telegram.json');
  return obj ? await obj.json() : { ownerIds: [] };
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
    'access-control-allow-headers': 'authorization, content-type, x-id, x-title, x-artist, x-duration, x-added-at',
    'access-control-max-age': '86400',
  };
}

async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, include: ['customMetadata', 'httpMetadata'] });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

function toTrack(obj) {
  const m = decodeMeta(obj.customMetadata);
  return {
    id: obj.key.slice('audio/'.length),
    title: m.title || 'Untitled',
    artist: m.artist || '',
    duration: Number(m.duration) || 0,
    size: obj.size,
    type: obj.httpMetadata?.contentType || 'audio/mpeg',
    addedAt: Number(m.addedAt) || new Date(obj.uploaded).getTime(),
    source: m.source || '',
  };
}

// Metadata values are URI-encoded so any title (emoji, accents…) survives storage.
const encodeMeta = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, encodeURIComponent(String(v ?? ''))]));
const decodeMeta = (m = {}) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, dec(v)]));

function dec(s) {
  if (!s) return '';
  try { return decodeURIComponent(s); } catch { return s; }
}

function clean(s, max = 120) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const stripExt = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ');
const guessMime = (name) => MIME_BY_EXT[(String(name).split('.').pop() || '').toLowerCase()] || '';
const audioKey = (id) => `audio/${id}`;
const putJson = (env, key, data) =>
  env.BUCKET.put(key, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
