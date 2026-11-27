// Audio playback, queue, shuffle/repeat and lock-screen controls.

// iOS only lets audio start from a tap. Playing a short silent sound on the first
// tap "unlocks" the audio element so later tracks can start on their own
// (auto-advance, lock-screen skip) even after an async download.
function makeSilentWav() {
  const rate = 8000, samples = 800;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.silent = makeSilentWav();
    this.queue = [];      // play order (shuffled or not)
    this.original = [];   // un-shuffled order
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';  // off | all | one
    this.loadingId = null;
    this.unlocked = false;
    this.url = null;
    this.token = 0;
    this.hooks = { getBlob: null, getTrack: () => null, onError: () => {}, onDuration: () => {} };

    const a = this.audio;
    a.addEventListener('ended', () => { if (!this.isSilent) this.next(true); });
    a.addEventListener('play', () => this.emit());
    // iOS only keeps lock-screen buttons that are registered once a track is
    // really "now playing", and forgets them when a new track starts. So
    // register on every 'playing' event, once more a moment later, and when the
    // app comes back to the foreground.
    a.addEventListener('playing', () => {
      if (this.isSilent) return;
      this.bindMediaSession();
      setTimeout(() => { if (this.playing) this.bindMediaSession(); }, 500);
    });
    document.addEventListener('visibilitychange', () => { if (this.playing) this.bindMediaSession(); });
    a.addEventListener('pause', () => this.emit());
    a.addEventListener('loadedmetadata', () => {
      const id = this.currentId;
      if (!this.isSilent && id && isFinite(a.duration)) this.hooks.onDuration(id, a.duration);
      this.updatePosition();
    });
    let last = 0;
    a.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - last > 1000) { last = now; this.updatePosition(); }
    });

    this.bindMediaSession();
  }

  // Lock-screen / AirPods controls. iOS shows "skip 10 seconds" buttons unless
  // next/previous track handlers are set and the seek-skip handlers are cleared,
  // and it can drop handlers when the audio source changes, so this runs again
  // every time a new track loads.
  bindMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
    set('play', () => this.play());
    set('pause', () => this.audio.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (d) => this.seek(d.seekTime));
    // Clear these last so iOS falls back to the previous/next track buttons.
    set('seekbackward', null);
    set('seekforward', null);
  }

  init(hooks) { Object.assign(this.hooks, hooks); }
  emit() { this.dispatchEvent(new Event('change')); }

  get currentId() { return this.queue[this.index] ?? null; }
  get isSilent() { return this.audio.src === this.silent; }
  get playing() { return !this.audio.paused && !this.isSilent; }

  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.audio.src = this.silent;
    this.audio.play().catch(() => {});
  }

  // Must be called straight from a tap (before any await) so iOS allows playback.
  playList(ids, start = 0, { shuffle } = {}) {
    if (!ids.length) return;
    this.unlock();
    if (shuffle !== undefined) this.shuffle = shuffle;
    this.original = ids.slice();
    if (this.shuffle) {
      const first = ids[start];
      this.queue = [first, ...shuffled(ids.filter((_, i) => i !== start))];
      this.index = 0;
    } else {
      this.queue = ids.slice();
      this.index = start;
    }
    return this.load(this.index);
  }

  async load(i, autoplay = true) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    const id = this.queue[i];
    const token = ++this.token;
    this.loadingId = id;
    this.emit();

    let blob;
    try {
      blob = await this.hooks.getBlob(id);
    } catch (err) {
      if (token !== this.token) return;
      this.loadingId = null;
      this.audio.pause();
      this.hooks.onError(err);
      this.emit();
      return;
    }
    if (token !== this.token) return;

    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.audio.src = this.url;
    this.loadingId = null;
    this.updateMetadata();
    if (autoplay) {
      try { await this.audio.play(); } catch (err) { if (err.name !== 'AbortError') this.hooks.onError(err); }
    }
    this.emit();
    this.prefetch();
  }

  // Download the next track ahead of time so auto-advance works on the lock screen.
  prefetch() {
    const nextId = this.queue[this.index + 1] ?? (this.repeat === 'all' ? this.queue[0] : null);
    if (nextId) this.hooks.getBlob(nextId).catch(() => {});
  }

  play() {
    if (this.currentId == null) return;
    this.unlock();
    if (this.isSilent || !this.audio.src) return this.load(this.index);
    this.audio.play().catch(() => {});
  }

  toggle() {
    if (this.playing) this.audio.pause();
    else this.play();
  }

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
      return;
    }
    if (this.index + 1 < this.queue.length) return this.load(this.index + 1);
    if (this.repeat === 'all') return this.load(0);
    if (auto) { this.audio.currentTime = 0; this.emit(); return; }
    return this.load(0, false);
  }

  prev() {
    if (!this.queue.length) return;
    if (this.audio.currentTime > 3 || this.index === 0) { this.audio.currentTime = 0; return; }
    this.load(this.index - 1);
  }

  seek(t) {
    if (isFinite(t)) this.audio.currentTime = Math.max(0, t);
    this.updatePosition();
  }

  setShuffle(on) {
    this.shuffle = on;
    const cur = this.currentId;
    if (cur == null) { this.emit(); return; }
    if (on) {
      const rest = this.original.slice();
      const at = rest.indexOf(cur);
      if (at >= 0) rest.splice(at, 1);
      this.queue = [cur, ...shuffled(rest)];
      this.index = 0;
    } else {
      this.queue = this.original.slice();
      this.index = Math.max(0, this.queue.indexOf(cur));
    }
    this.emit();
    this.prefetch();
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.emit();
  }

  playNext(id) {
    if (!this.queue.length) return this.playList([id], 0);
    this.queue.splice(this.index + 1, 0, id);
    const at = this.original.indexOf(this.currentId);
    this.original.splice(at + 1, 0, id);
    this.emit();
    this.prefetch();
  }

  addToQueue(id) {
    if (!this.queue.length) return this.playList([id], 0);
    this.queue.push(id);
    this.original.push(id);
    this.emit();
  }

  removeTrack(id) {
    const cur = this.currentId;
    this.original = this.original.filter((x) => x !== id);
    if (cur === id) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.queue = [];
      this.original = [];
      this.index = -1;
    } else {
      this.queue = this.queue.filter((x) => x !== id);
      this.index = this.queue.indexOf(cur);
    }
    this.emit();
  }

  updateMetadata() {
    const ms = navigator.mediaSession;
    const t = this.hooks.getTrack(this.currentId);
    if (!ms || !t || !window.MediaMetadata) return;
    this.bindMediaSession();
    const base = new URL('icons/', location.href).href;
    ms.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || 'Me',
      album: 'Selftape',
      artwork: [
        { src: base + 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: base + 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  }

  updatePosition() {
    const ms = navigator.mediaSession;
    const a = this.audio;
    if (!ms?.setPositionState || this.isSilent || !isFinite(a.duration) || a.duration <= 0) return;
    try {
      ms.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate || 1 });
    } catch {}
  }
}

export const player = new Player();
