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
      'x-filename': encodeURIComponent(t.filename || ''),
    },
  })).json();

export const updateTrack = (s, t) =>
  call(s, `/tracks/${t.id}`, { method: 'PATCH', ...jsonBody({ title: t.title, artist: t.artist, duration: t.duration, genre: t.genre || '' }) });

export const saveFeatures = (s, id, features) => call(s, `/tracks/${id}`, { method: 'PATCH', ...jsonBody({ features }) });

export const findMissingGenres = async (s) => (await call(s, '/genres/find-missing', { method: 'POST' })).json();

export const deleteTrack = (s, id) => call(s, `/tracks/${id}`, { method: 'DELETE' });

export const savePlaylists = (s, data) => call(s, '/playlists', { method: 'PUT', ...jsonBody(data) });

export const getCover = async (s, id) => (await call(s, `/tracks/${id}/cover`)).blob();

export const findCover = async (s, id) => (await call(s, `/tracks/${id}/cover/find`, { method: 'POST' })).json();

export const removeCover = async (s, id) => (await call(s, `/tracks/${id}/cover`, { method: 'DELETE' })).json();

export const coverOptions = async (s, id, q) =>
  (await call(s, `/tracks/${id}/cover/options${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json();

export const setCover = async (s, id, url) =>
  (await call(s, `/tracks/${id}/cover`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })).json();

export const findArtistPhotos = async (s, artists) =>
  (await call(s, '/artist-photos/find', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artists }) })).json();

export const getArtistPhoto = async (s, name) => (await call(s, `/artist-photo?name=${encodeURIComponent(name)}`)).blob();

export const setArtistPhoto = async (s, name, url) =>
  (await call(s, '/artist-photo', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, url }) })).json();

export const artistPhotoOptions = async (s, q) => (await call(s, `/artist-photo/options?q=${encodeURIComponent(q)}`)).json();

export const findMissingCovers = async (s) => (await call(s, '/covers/find-missing', { method: 'POST' })).json();

export const connectTelegram = async (s) => (await call(s, '/telegram/setup', { method: 'POST' })).json();
