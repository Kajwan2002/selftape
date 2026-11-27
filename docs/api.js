// Talks to your Cloudflare Worker.
export const isConfigured = (s) => !!(s.serverUrl && s.token);

const base = (s) => s.serverUrl.replace(/\/+$/, '');

async function call(s, path, opts = {}) {
  let res;
  try {
    res = await fetch(base(s) + path, {
      ...opts,
      headers: { authorization: `Bearer ${s.token}`, ...(opts.headers || {}) },
    });
  } catch {
    throw new Error("Couldn't reach your server");
  }
  if (!res.ok) {
    let msg = `Server error (${res.status})`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

const jsonBody = (data) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

export const getLibrary = async (s) => (await call(s, '/library')).json();

export const downloadAudio = async (s, id) => (await call(s, `/tracks/${id}/audio`)).blob();

export const uploadTrack = async (s, t, blob) =>
  (await call(s, '/tracks', {
    method: 'POST',
    body: blob,
    headers: {
      'content-type': t.type || blob.type || 'application/octet-stream',
      'x-id': t.id,
      'x-title': encodeURIComponent(t.title || ''),
      'x-artist': encodeURIComponent(t.artist || ''),
      'x-duration': String(t.duration || 0),
      'x-added-at': String(t.addedAt || Date.now()),
    },
  })).json();

export const updateTrack = (s, t) =>
  call(s, `/tracks/${t.id}`, { method: 'PATCH', ...jsonBody({ title: t.title, artist: t.artist, duration: t.duration }) });

export const deleteTrack = (s, id) => call(s, `/tracks/${id}`, { method: 'DELETE' });

export const savePlaylists = (s, data) => call(s, '/playlists', { method: 'PUT', ...jsonBody(data) });

export const connectTelegram = async (s) => (await call(s, '/telegram/setup', { method: 'POST' })).json();
