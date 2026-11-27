// Tiny IndexedDB wrapper. Stores: tracks (metadata), blobs (audio files), kv (settings etc.)
const DB_NAME = 'selftape';
const VERSION = 1;
let dbPromise;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('tracks', { keyPath: 'id' });
      db.createObjectStore('blobs');
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const db = {
  all: async (name) => wrap((await store(name)).getAll()),
  keys: async (name) => wrap((await store(name)).getAllKeys()),
  get: async (name, key) => wrap((await store(name)).get(key)),
  put: async (name, value, key) => wrap((await store(name, 'readwrite')).put(value, key)),
  del: async (name, key) => wrap((await store(name, 'readwrite')).delete(key)),
};
