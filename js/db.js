// IndexedDB wrapper for boards, tracks, and settings
const DB_NAME = 'SoundboardDB';
const DB_VER = 1;

let db;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('boards')) {
        const bs = d.createObjectStore('boards', { keyPath: 'id' });
        bs.createIndex('order', 'order');
      }
      if (!d.objectStoreNames.contains('tracks')) {
        const ts = d.createObjectStore('tracks', { keyPath: 'id' });
        ts.createIndex('boardId', 'boardId');
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('audio')) {
        d.createObjectStore('audio', { keyPath: 'trackId' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function all(store, index, query) {
  return new Promise((resolve, reject) => {
    const s = index ? tx(store).index(index) : tx(store);
    const req = query !== undefined ? s.getAll(query) : s.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function put(store, obj) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').put(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function del(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function get(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Boards
export const getBoards = () => all('boards');
export const putBoard = b => put('boards', b);
export const deleteBoard = id => del('boards', id);

// Tracks
export const getTracksForBoard = boardId => all('tracks', 'boardId', boardId);
export const getAllTracks = () => all('tracks');
export const putTrack = t => put('tracks', t);
export const deleteTrack = id => del('tracks', id);

// Audio blobs
export const getAudio = trackId => get('audio', trackId);
export const putAudio = (trackId, blob) => put('audio', { trackId, blob });
export const deleteAudio = trackId => del('audio', trackId);

// Settings
export const getSetting = key => get('settings', key).then(r => r?.value);
export const setSetting = (key, value) => put('settings', { key, value });
