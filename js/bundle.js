/* ── DB ─────────────────────────────────────────────────────────────────── */
const DB_NAME = 'SoundboardDB', DB_VER = 1;
let _db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('boards')) {
        d.createObjectStore('boards', { keyPath: 'id' }).createIndex('order', 'order');
      }
      if (!d.objectStoreNames.contains('tracks')) {
        d.createObjectStore('tracks', { keyPath: 'id' }).createIndex('boardId', 'boardId');
      }
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('audio'))    d.createObjectStore('audio',    { keyPath: 'trackId' });
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror  = () => reject(req.error);
  });
}

function _tx(store, mode) { return _db.transaction(store, mode || 'readonly').objectStore(store); }
function _all(store, index, query) {
  return new Promise((res, rej) => {
    const s = index ? _tx(store).index(index) : _tx(store);
    const r = query !== undefined ? s.getAll(query) : s.getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function _put(store, obj) {
  return new Promise((res, rej) => { const r = _tx(store,'readwrite').put(obj); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
}
function _del(store, key) {
  return new Promise((res, rej) => { const r = _tx(store,'readwrite').delete(key); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });
}
function _get(store, key) {
  return new Promise((res, rej) => { const r = _tx(store).get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
}

const DB = {
  getBoards:         ()      => _all('boards'),
  putBoard:          b       => _put('boards', b),
  deleteBoard:       id      => _del('boards', id),
  getTracksForBoard: boardId => _all('tracks', 'boardId', boardId),
  putTrack:          t       => _put('tracks', t),
  deleteTrack:       id      => _del('tracks', id),
  getAudio:          id      => _get('audio', id),
  putAudio:          (id, blob) => _put('audio', { trackId: id, blob }),
  deleteAudio:       id      => _del('audio', id),
  getAllTracks:      ()      => _all('tracks'),
  getSetting:        key     => _get('settings', key).then(r => r && r.value),
  setSetting:        (key, value) => _put('settings', { key, value }),
};

/* ── Audio Engine ───────────────────────────────────────────────────────── */
let _ctx;
function getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}

const buffers = new Map();
const active  = new Map();

function decodeAudio(trackId, blob) {
  return blob.arrayBuffer().then(arr => getCtx().decodeAudioData(arr)).then(buf => {
    buffers.set(trackId, buf); return buf;
  });
}

function isPlaying(trackId)  { return active.has(trackId); }
function getBuffer(trackId)  { return buffers.get(trackId) || null; }
function clearBuffer(trackId){ buffers.delete(trackId); }
function getActiveIds()      { return [...active.keys()]; }

function getProgress(trackId) {
  if (!active.has(trackId)) return null;
  const { startTime, startOffset, duration } = active.get(trackId);
  const elapsed = getCtx().currentTime - startTime + startOffset;
  return { elapsed, duration, progress: Math.min(elapsed / duration, 1) };
}

function playTrack(trackId, opts) {
  stopTrack(trackId, 0);
  const buf = buffers.get(trackId);
  if (!buf) return false;
  opts = opts || {};
  const { volume=1, fadeIn=0, fadeOut=0, trimStart=0, trimEnd=0, onEnd } = opts;
  const dur = buf.duration - trimStart - trimEnd;
  if (dur <= 0) return false;

  const ac = getCtx(), now = ac.currentTime;
  const gain = ac.createGain();
  gain.connect(ac.destination);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(gain);

  if (fadeIn > 0) { gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(volume, now + fadeIn); }
  else            { gain.gain.setValueAtTime(volume, now); }

  let foTimer = null;
  if (fadeOut > 0) {
    const fs = dur - fadeOut;
    if (fs > 0) foTimer = setTimeout(() => {
      if (!active.has(trackId)) return;
      const t = ac.currentTime;
      const g = active.get(trackId).gainNode;
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + fadeOut);
    }, fs * 1000);
  }

  src.start(now, trimStart, dur);
  src.onended = () => { if (foTimer) clearTimeout(foTimer); active.delete(trackId); if (onEnd) onEnd(trackId); };
  active.set(trackId, { source: src, gainNode: gain, startTime: now, startOffset: trimStart, duration: dur, fadeOutTimer: foTimer, volume });
  return true;
}

function stopTrack(trackId, fadeDur) {
  if (!active.has(trackId)) return;
  const { source, gainNode, fadeOutTimer } = active.get(trackId);
  if (fadeOutTimer) clearTimeout(fadeOutTimer);
  const ac = getCtx(), now = ac.currentTime;
  if (fadeDur > 0) { gainNode.gain.setValueAtTime(gainNode.gain.value, now); gainNode.gain.linearRampToValueAtTime(0, now + fadeDur); try { source.stop(now + fadeDur); } catch(_){} }
  else             { gainNode.gain.setValueAtTime(0, now); try { source.stop(now + 0.01); } catch(_){} }
  active.delete(trackId);
}

function stopAll(fadeDur) { [...active.keys()].forEach(id => stopTrack(id, fadeDur || 0)); }

/* ── Grid Columns (matches CSS breakpoints) ─────────────────────────────── */
function getGridCols() {
  const w = window.innerWidth || 390;
  if (w >= 1600) return 10;
  if (w >= 1200) return 8;
  if (w >= 900)  return 6;
  if (w >= 600)  return 5;
  return 4;
}

/* ── App State ──────────────────────────────────────────────────────────── */
let boards = [], currentBoardId = null, tracks = [], defaults = {}, editingTrackId = null;
let editMode = false;
let hotkeysEnabled = false;
let activeFilter = null, _wakeLock = null;
let dragTileId = null, dragGhost = null;
let dragDropCol = -1, dragDropRow = -1;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function makeBoard(name) { return { id: uid(), name, color: '#16213e', order: boards.length }; }

/* Find next empty grid cell (reading order) */
function nextGridPos() {
  const cols = getGridCols();
  for (let row = 0; row < 200; row++) {
    for (let col = 0; col < cols; col++) {
      if (!tracks.some(t => t.gridCol === col && t.gridRow === row)) return { col, row };
    }
  }
  return { col: 0, row: 200 };
}

function makeTrack(name) {
  const pos = nextGridPos();
  return {
    id: uid(), boardId: currentBoardId, name, type: 'track',
    color: '#0f3460', image: null, order: tracks.length,
    gridCol: pos.col, gridRow: pos.row,
    volume: defaults.volume, fadeIn: defaults.fadeIn, fadeOut: defaults.fadeOut,
    trimStart: defaults.trimStart, trimEnd: defaults.trimEnd,
    autoFadeOnStop: defaults.autoFadeOnStop, autoPlayNext: defaults.autoPlayNext,
    loop: false, hideLabel: false, hotkey: null, tags: [], audioFile: null,
    hasPlayed: false
  };
}

function makeLabel(name) {
  const pos = nextGridPos();
  return {
    id: uid(), boardId: currentBoardId, name, type: 'label',
    color: '#1a1a3a', image: null, order: tracks.length,
    gridCol: pos.col, gridRow: pos.row,
    hideLabel: false
  };
}

/* ── Edit Mode ──────────────────────────────────────────────────────────── */
function enterEditMode() {
  editMode = true;
  renderGrid();
  document.getElementById('edit-mode-bar').classList.remove('hidden');
  toast('Long-press and drag tiles to rearrange');
}

function exitEditMode() {
  editMode = false;
  if (dragGhost) { dragGhost.remove(); dragGhost = null; }
  clearDropHighlight();
  dragTileId = null; dragDropCol = -1; dragDropRow = -1;
  document.getElementById('edit-mode-bar').classList.add('hidden');
  renderGrid();
}

/* ── Label ──────────────────────────────────────────────────────────────── */
async function createLabel() {
  const name = prompt('Label text:');
  if (!name || !name.trim()) return;
  const lbl = makeLabel(name.trim());
  await DB.putTrack(lbl);
  tracks.push(lbl);
  renderGrid();
}

/* ── Init ───────────────────────────────────────────────────────────────── */
async function init() {
  await openDB();
  defaults = (await DB.getSetting('defaults')) || { volume:1, fadeIn:0, fadeOut:3, trimStart:0, trimEnd:0, autoFadeOnStop:true, autoPlayNext:false };
  hotkeysEnabled = !!(await DB.getSetting('hotkeysEnabled'));
  boards = await DB.getBoards();
  boards.sort((a,b) => a.order - b.order);
  if (!boards.length) { const b = makeBoard('Board 1'); await DB.putBoard(b); boards = [b]; }
  currentBoardId = boards[0].id;
  await loadBoard(currentBoardId);
  render();
  setupGlobal();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  // On a fresh device with no local data, auto-load board.json from the server
  const allTracks = await DB.getAllTracks();
  if (allTracks.length === 0) tryAutoLoad();
}

async function loadBoard(boardId) {
  currentBoardId = boardId;
  activeFilter = null;
  tracks = await DB.getTracksForBoard(boardId);
  // Sort by grid position for display and autoPlayNext ordering
  const cols = getGridCols();
  tracks.sort((a, b) => {
    const aPos = (a.gridRow || 0) * cols + (a.gridCol || 0);
    const bPos = (b.gridRow || 0) * cols + (b.gridCol || 0);
    return aPos - bPos || (a.order || 0) - (b.order || 0);
  });
  // Migrate old tracks that lack grid positions
  tracks.forEach((t, i) => {
    if (t.gridCol === undefined || t.gridRow === undefined) {
      t.gridCol = i % cols;
      t.gridRow = Math.floor(i / cols);
      DB.putTrack(t);
    }
  });
  for (const t of tracks) {
    if (t.type === 'label') continue;
    if (!getBuffer(t.id)) { const rec = await DB.getAudio(t.id); if (rec) await decodeAudio(t.id, rec.blob); }
  }
}

/* ── Render ─────────────────────────────────────────────────────────────── */
function render() { renderTabs(); renderGrid(); renderFilterBar(); }

function renderTabs() {
  const bar = document.getElementById('board-tabs');
  bar.innerHTML = '';
  boards.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'board-tab' + (b.id === currentBoardId ? ' active' : '');
    btn.textContent = b.name;
    btn.style.borderBottomColor = b.color;
    btn.onclick = () => switchBoard(b.id);
    btn.oncontextmenu = e => { e.preventDefault(); openBoardEditor(b); };
    // Long-press on touch devices opens board settings (same as right-click on desktop)
    let lpTimer = null;
    btn.addEventListener('touchstart', () => { lpTimer = setTimeout(() => { lpTimer = null; openBoardEditor(b); }, 600); }, { passive: true });
    btn.addEventListener('touchend',  () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
    btn.addEventListener('touchmove', () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
    bar.appendChild(btn);
  });
  const add = document.createElement('button');
  add.className = 'board-tab add-board';
  add.textContent = '+';
  add.title = 'New board';
  add.onclick = addBoard;
  bar.appendChild(add);
}

function renderGrid() {
  const grid = document.getElementById('track-grid');
  grid.innerHTML = '';

  // Find the number of rows needed (at least 2 visible rows)
  const maxRow = tracks.length ? Math.max(...tracks.map(t => t.gridRow || 0)) : -1;
  const numRows = Math.max(maxRow + 2, 3);

  // Place each tile at its explicit grid position
  tracks.forEach(t => {
    const el = buildTile(t);
    el.style.gridColumn = (t.gridCol + 1);
    el.style.gridRow    = (t.gridRow + 1);
    // Dim tiles that don't match the active tag filter (labels always visible)
    if (activeFilter && t.type !== 'label' && !(t.tags || []).includes(activeFilter)) {
      el.style.opacity = '0.15';
      el.style.pointerEvents = 'none';
    }
    grid.appendChild(el);
  });

  // Fill empty cells — always show subtle placeholders so grid doesn't collapse
  const cols = getGridCols();
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!tracks.some(t => t.gridCol === col && t.gridRow === row)) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell-empty';
        cell.style.gridColumn = (col + 1);
        cell.style.gridRow    = (row + 1);
        cell.dataset.col = col;
        cell.dataset.row = row;
        grid.appendChild(cell);
      }
    }
  }

  setupGridDrag();
}

function buildTile(t) {
  const isLabel = t.type === 'label';
  const playing = !isLabel && isPlaying(t.id);

  const cls = ['track-tile'];
  if (playing)                              cls.push('playing');
  if (!isLabel && t.hasPlayed && !playing)  cls.push('played');
  if (isLabel)                              cls.push('label-tile');
  if (editMode)                             cls.push('editing');

  const tile = document.createElement('div');
  tile.className = cls.join(' ');
  tile.dataset.id  = t.id;
  tile.dataset.col = t.gridCol;
  tile.dataset.row = t.gridRow;
  tile.style.backgroundColor = t.color;
  tile.draggable = true;

  if (t.image) {
    const img = document.createElement('img');
    img.src = t.image; img.className = 'tile-image';
    img.style.pointerEvents = 'none';
    tile.appendChild(img);
  }

  if (!t.hideLabel) {
    const lbl = document.createElement('div');
    lbl.className = 'tile-label'; lbl.textContent = t.name;
    tile.appendChild(lbl);
  }

  if (!isLabel && t.loop) {
    const loopBadge = document.createElement('div');
    loopBadge.className = 'tile-loop-badge';
    loopBadge.textContent = '↺';
    tile.appendChild(loopBadge);
  }

  if (!isLabel && t.hotkey && hotkeysEnabled) {
    const hkBadge = document.createElement('div');
    hkBadge.className = 'tile-hotkey-badge';
    hkBadge.textContent = t.hotkey === ' ' ? 'SPC' : t.hotkey.toUpperCase().slice(0, 4);
    tile.appendChild(hkBadge);
  }

  if (playing) {
    const track = document.createElement('div');
    track.className = 'tile-prog-track';
    tile.appendChild(track);

    const bar = document.createElement('div');
    bar.className = 'tile-progress'; bar.id = 'prog-' + t.id;
    tile.appendChild(bar);

    const timeEl = document.createElement('div');
    timeEl.className = 'tile-time'; timeEl.id = 'time-' + t.id;
    tile.appendChild(timeEl);

    animateProgress(t.id);
  }

  const gear = document.createElement('button');
  gear.className = 'tile-settings-btn'; gear.innerHTML = '⚙';
  gear.onclick = e => { e.stopPropagation(); openTrackEditor(t); };
  tile.appendChild(gear);

  /* Touch: long-press → edit mode; in edit mode → drag immediately */
  let lpTimer = null;
  tile.addEventListener('touchstart', e => {
    if (editMode) { e.preventDefault(); startTouchDrag(t.id, e.touches[0]); return; }
    lpTimer = setTimeout(() => { lpTimer = null; enterEditMode(); }, 600);
  }, { passive: false });
  tile.addEventListener('touchend',  () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
  tile.addEventListener('touchmove', () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });

  /* Click — normal mode only */
  tile.onclick = () => { if (editMode || isLabel) return; tapTile(t); };

  /* HTML5 drag (desktop) */
  tile.ondragstart = e => {
    dragTileId = t.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.id);
    setTimeout(() => { tile.style.opacity = '0.35'; }, 0);
  };
  tile.ondragend = () => {
    tile.style.opacity = '';
    clearDropHighlight();
    dragTileId = null; dragDropCol = -1; dragDropRow = -1;
  };

  return tile;
}

/* ── Touch Drag ─────────────────────────────────────────────────────────── */
function startTouchDrag(tileId, touch) {
  dragTileId = tileId;
  const orig = document.querySelector(`.track-tile[data-id="${tileId}"]`);
  if (!orig) return;
  const rect = orig.getBoundingClientRect();

  dragGhost = orig.cloneNode(true);
  // Strip data-col/row from ghost so calcDropCell never mistakes it for a target
  dragGhost.removeAttribute('data-col');
  dragGhost.removeAttribute('data-row');
  dragGhost.removeAttribute('data-id');
  // pointer-events:none doesn't inherit in HTML — must set on all descendants
  dragGhost.querySelectorAll('*').forEach(el => el.style.pointerEvents = 'none');
  dragGhost.style.cssText = `
    position:fixed; z-index:1000; pointer-events:none;
    width:${rect.width}px; height:${rect.height}px;
    left:${touch.clientX - rect.width/2}px; top:${touch.clientY - rect.height/2}px;
    opacity:.85; transform:scale(1.08) rotate(2deg);
    box-shadow:0 12px 32px rgba(0,0,0,.7); border-radius:var(--tile-radius);
    transition:none;
  `;
  document.body.appendChild(dragGhost);
  orig.style.opacity = '0.2';
  orig.style.pointerEvents = 'none';

  document.addEventListener('touchmove', onTouchDragMove, { passive: false });
  document.addEventListener('touchend',  onTouchDragEnd,  { once: true });
}

function onTouchDragMove(e) {
  if (!dragGhost || !dragTileId) return;
  e.preventDefault();
  const touch = e.touches[0];
  const gw = parseFloat(dragGhost.style.width);
  const gh = parseFloat(dragGhost.style.height);
  dragGhost.style.left = (touch.clientX - gw/2) + 'px';
  dragGhost.style.top  = (touch.clientY - gh/2) + 'px';

  const cell = calcDropCell(touch.clientX, touch.clientY);
  if (cell && (cell.col !== dragDropCol || cell.row !== dragDropRow)) {
    dragDropCol = cell.col; dragDropRow = cell.row;
    highlightDropCell(cell.col, cell.row);
  }
}

function onTouchDragEnd(e) {
  document.removeEventListener('touchmove', onTouchDragMove);
  const touch = e.changedTouches[0];
  const cell = calcDropCell(touch.clientX, touch.clientY);

  if (dragGhost) { dragGhost.remove(); dragGhost = null; }
  const orig = document.querySelector(`.track-tile[data-id="${dragTileId}"]`);
  if (orig) { orig.style.opacity = ''; orig.style.pointerEvents = ''; }
  clearDropHighlight();

  const tid = dragTileId;
  dragTileId = null; dragDropCol = -1; dragDropRow = -1;
  if (cell) moveToCell(tid, cell.col, cell.row);
}

/* ── Grid Drag (desktop) ────────────────────────────────────────────────── */
function setupGridDrag() {
  const grid = document.getElementById('track-grid');

  grid.ondragover = e => {
    e.preventDefault();
    if (!dragTileId) return;
    e.dataTransfer.dropEffect = 'move';
    const cell = calcDropCell(e.clientX, e.clientY);
    if (cell && (cell.col !== dragDropCol || cell.row !== dragDropRow)) {
      dragDropCol = cell.col; dragDropRow = cell.row;
      highlightDropCell(cell.col, cell.row);
    }
  };

  grid.ondragleave = e => {
    if (!grid.contains(e.relatedTarget)) clearDropHighlight();
  };

  grid.ondrop = e => {
    e.preventDefault();
    if (!dragTileId) {
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
      return;
    }
    const cell = dragDropCol >= 0
      ? { col: dragDropCol, row: dragDropRow }
      : calcDropCell(e.clientX, e.clientY);
    clearDropHighlight();
    const tid = dragTileId;
    dragTileId = null; dragDropCol = -1; dragDropRow = -1;
    if (cell) moveToCell(tid, cell.col, cell.row);
  };
}

/* calcDropCell: find which grid cell the pointer is over */
function calcDropCell(clientX, clientY) {
  // Ghost has pointer-events:none so elementFromPoint sees through it
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;

  // Direct hit on empty cell or tile with data-col/row
  const target = el.closest('[data-col]');
  if (target && target.dataset.col !== undefined) {
    return { col: parseInt(target.dataset.col), row: parseInt(target.dataset.row) };
  }

  // Fallback: calculate from grid geometry
  const grid = document.getElementById('track-grid');
  const rect = grid.getBoundingClientRect();
  const GAP = 10;
  const numCols = getGridCols();
  const cellW = (rect.width - GAP * (numCols - 1)) / numCols;
  const col = Math.max(0, Math.min(numCols - 1,
    Math.floor((clientX - rect.left) / (cellW + GAP))));
  const row = Math.max(0,
    Math.floor((clientY - rect.top) / (cellW + GAP)));
  return { col, row };
}

function highlightDropCell(col, row) {
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  const cell = document.querySelector(`[data-col="${col}"][data-row="${row}"]`);
  if (cell) cell.classList.add('drop-target');
}

function clearDropHighlight() {
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
}

/* Move tile to a specific grid cell; swap if occupied */
async function moveToCell(tileId, col, row) {
  if (!tileId) return;
  const t = tracks.find(x => x.id === tileId);
  if (!t) return;
  if (t.gridCol === col && t.gridRow === row) { renderGrid(); return; }

  const other = tracks.find(x => x.id !== tileId && x.gridCol === col && x.gridRow === row);
  if (other) {
    // Swap positions
    const oldCol = t.gridCol, oldRow = t.gridRow;
    other.gridCol = oldCol; other.gridRow = oldRow;
    t.gridCol = col; t.gridRow = row;
    await DB.putTrack(other);
  } else {
    t.gridCol = col; t.gridRow = row;
  }
  await DB.putTrack(t);
  renderGrid();
}

/* ── Playback ───────────────────────────────────────────────────────────── */
function tapTile(t) {
  if (isPlaying(t.id)) {
    stopTrack(t.id, t.autoFadeOnStop ? t.fadeOut : 0);
    render(); return;
  }
  if (!getBuffer(t.id)) { toast('No audio — tap ⚙ → Replace Audio'); return; }
  stopAll(0);
  playTrack(t.id, { volume: t.volume, fadeIn: t.fadeIn, fadeOut: t.fadeOut, trimStart: t.trimStart, trimEnd: t.trimEnd, onEnd: onTrackEnd });
  t.hasPlayed = true; DB.putTrack(t);
  render();
}

function onTrackEnd(trackId) {
  const t = tracks.find(x => x.id === trackId);
  if (t && t.loop) {
    playTrack(t.id, {
      volume: t.volume, fadeIn: t.fadeIn, fadeOut: t.fadeOut,
      trimStart: t.trimStart, trimEnd: t.trimEnd, onEnd: onTrackEnd
    });
    render(); return;
  }
  if (t && t.autoPlayNext) {
    const c = getGridCols();
    const sorted = [...tracks].sort((a, b) =>
      (a.gridRow * c + a.gridCol) - (b.gridRow * c + b.gridCol));
    const idx = sorted.findIndex(x => x.id === trackId);
    const next = sorted[idx + 1];
    if (next && next.type !== 'label' && getBuffer(next.id)) { tapTile(next); return; }
  }
  render();
}

const progRAF = new Map();
function animateProgress(trackId) {
  if (progRAF.has(trackId)) return;
  function tick() {
    const bar    = document.getElementById('prog-' + trackId);
    const timeEl = document.getElementById('time-' + trackId);
    if (!bar || !isPlaying(trackId)) { progRAF.delete(trackId); return; }
    const p = getProgress(trackId);
    if (p) {
      bar.style.width = (p.progress * 100) + '%';
      const rem = Math.max(0, p.duration - p.elapsed);
      if (timeEl) timeEl.textContent = '-' + secToMmss(rem);
    }
    progRAF.set(trackId, requestAnimationFrame(tick));
  }
  progRAF.set(trackId, requestAnimationFrame(tick));
}

/* ── Board actions ──────────────────────────────────────────────────────── */
async function switchBoard(boardId) {
  if (editMode) exitEditMode();
  await loadBoard(boardId); render();
}

async function addBoard() {
  const name = prompt('Board name:');
  if (!name) return;
  const b = makeBoard(name.trim()); boards.push(b); await DB.putBoard(b); await switchBoard(b.id);
}

async function resetAllPlayed() {
  const all = await DB.getAllTracks();
  for (const t of all) {
    if (t.type === 'label') continue;
    if (t.hasPlayed) { t.hasPlayed = false; await DB.putTrack(t); }
  }
  tracks.forEach(t => { if (t.type !== 'label') t.hasPlayed = false; });
  renderGrid();
  toast('All tracks reset');
}

/* ── Import ─────────────────────────────────────────────────────────────── */
async function handleFiles(files) {
  const audio = [...files].filter(f => f.type.startsWith('audio/'));
  if (!audio.length) { toast('No audio files found'); return; }
  for (const f of audio) {
    const t = makeTrack(f.name.replace(/\.[^.]+$/, ''));
    t.audioFile = f.name;
    await DB.putTrack(t); await DB.putAudio(t.id, f); await decodeAudio(t.id, f);
    t.volume = normalizeVolume(getBuffer(t.id));
    await DB.putTrack(t);
    tracks.push(t);
  }
  renderGrid();
}

/* ── Track editor ───────────────────────────────────────────────────────── */
function openTrackEditor(t) {
  editingTrackId = t.id;
  modalCursor = t.trimStart || 0;
  const m = document.getElementById('track-modal');
  const isLabel = t.type === 'label';

  if (isLabel) m.classList.add('is-label'); else m.classList.remove('is-label');

  m.querySelector('h2').childNodes[0].textContent = isLabel ? 'Label Settings ' : 'Track Settings ';
  m.querySelector('#te-name').value  = t.name;
  m.querySelector('#te-color').value = t.color;

  if (!isLabel) {
    m.querySelector('#te-volume').value = t.volume;
    document.getElementById('te-vol-val').textContent = Math.round(t.volume * 100) + '%';
    m.querySelector('#te-fadein').value    = t.fadeIn;
    m.querySelector('#te-fadeout').value   = t.fadeOut;
    m.querySelector('#te-trimstart').value = secToMmss(t.trimStart);
    m.querySelector('#te-trimend').value   = secToMmss(t.trimEnd);
    m.querySelector('#te-autofade').checked = t.autoFadeOnStop;
    m.querySelector('#te-autonext').checked = t.autoPlayNext;
    m.querySelector('#te-loop').checked = !!t.loop;
    m.querySelector('#te-tags').value = (t.tags || []).join(', ');
    const hotkeyInput = document.getElementById('te-hotkey');
    hotkeyInput.value = t.hotkey ? (t.hotkey === ' ' ? 'Space' : t.hotkey) : '';
    hotkeyInput.dataset.capturedKey = t.hotkey || '';
    const buf = getBuffer(t.id);
    m.querySelector('#te-duration').textContent = buf ? secToMmss(buf.duration) : 'No audio loaded';
    const timeEl = document.getElementById('modal-time');
    if (timeEl) timeEl.textContent = secToMmss(modalCursor) + ' / ' + (buf ? secToMmss(buf.duration) : '0:00');
  }

  m.querySelector('#te-board').innerHTML = boards.map(b =>
    `<option value="${b.id}"${b.id===t.boardId?' selected':''}>${b.name}</option>`).join('');

  // Image-dependent UI
  const hasImage = !!t.image;
  document.getElementById('te-remove-image').style.display = hasImage ? '' : 'none';
  document.getElementById('te-hide-label-row').style.display = hasImage ? '' : 'none';
  if (hasImage) m.querySelector('#te-hide-label').checked = !!t.hideLabel;

  m.classList.remove('hidden');

  if (!isLabel) setTimeout(() => { precomputeWaveform(t.id); drawWaveformForModal(t.id); }, 60);
}

async function saveTrack() {
  const t = tracks.find(x => x.id === editingTrackId); if (!t) return;
  const m = document.getElementById('track-modal');
  t.name  = m.querySelector('#te-name').value.trim() || t.name;
  t.color = m.querySelector('#te-color').value;

  if (t.type !== 'label') {
    t.volume    = parseFloat(m.querySelector('#te-volume').value);
    t.fadeIn    = parseFloat(m.querySelector('#te-fadein').value);
    t.fadeOut   = parseFloat(m.querySelector('#te-fadeout').value);
    t.trimStart = mmssToSec(m.querySelector('#te-trimstart').value);
    t.trimEnd   = mmssToSec(m.querySelector('#te-trimend').value);
    t.autoFadeOnStop = m.querySelector('#te-autofade').checked;
    t.autoPlayNext   = m.querySelector('#te-autonext').checked;
    t.loop           = m.querySelector('#te-loop').checked;
    t.hotkey         = document.getElementById('te-hotkey').dataset.capturedKey || null;
    t.tags           = m.querySelector('#te-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (t.image) t.hideLabel = m.querySelector('#te-hide-label').checked;

  await DB.putTrack(t); closeModal('track-modal'); renderGrid();
}

async function moveTrackToBoard() {
  const t = tracks.find(x => x.id === editingTrackId); if (!t) return;
  const targetId = document.getElementById('te-board').value;
  if (targetId === t.boardId) { toast('Already on that board'); return; }
  const targetName = (boards.find(b => b.id === targetId) || {}).name || 'board';
  t.boardId = targetId;
  tracks = tracks.filter(x => x.id !== t.id);
  await DB.putTrack(t);
  closeModal('track-modal'); renderGrid();
  toast('Moved to ' + targetName);
}

async function copyTrackToBoard() {
  const src = tracks.find(x => x.id === editingTrackId); if (!src) return;
  const targetId = document.getElementById('te-board').value;
  const targetName = (boards.find(b => b.id === targetId) || {}).name || 'board';

  const newId = uid();
  const copy = Object.assign({}, src, { id: newId, boardId: targetId, order: 9999, hasPlayed: false });
  await DB.putTrack(copy);

  if (src.type !== 'label') {
    const audio = await DB.getAudio(src.id);
    if (audio) {
      await DB.putAudio(newId, audio.blob);
      if (targetId === currentBoardId) { tracks.push(copy); await decodeAudio(newId, audio.blob); renderGrid(); }
    }
  } else {
    if (targetId === currentBoardId) { tracks.push(copy); renderGrid(); }
  }
  toast('Copied to ' + targetName);
}

async function deleteTrackAction() {
  const t = tracks.find(x => x.id === editingTrackId);
  if (!t || !confirm('Delete this ' + (t.type === 'label' ? 'label' : 'track') + '?')) return;
  if (t.type !== 'label') { stopTrack(t.id, 0); clearBuffer(t.id); await DB.deleteAudio(t.id); }
  await DB.deleteTrack(t.id);
  tracks = tracks.filter(x => x.id !== t.id);
  closeModal('track-modal'); render();
}

function replaceAudio() {
  const inp = document.createElement('input'); inp.type='file'; inp.accept='audio/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    await DB.putAudio(editingTrackId, f); await decodeAudio(editingTrackId, f);
    const t = tracks.find(x => x.id === editingTrackId);
    if (t) {
      t.audioFile = f.name;
      t.volume = normalizeVolume(getBuffer(editingTrackId));
      await DB.putTrack(t);
      document.getElementById('te-volume').value = t.volume;
      document.getElementById('te-vol-val').textContent = Math.round(t.volume * 100) + '%';
    }
    const dur = getBuffer(editingTrackId) && getBuffer(editingTrackId).duration;
    document.getElementById('te-duration').textContent = dur ? fmt(dur) : '—';
    precomputeWaveform(editingTrackId); drawWaveformForModal(editingTrackId);
    toast('Audio replaced');
  };
  inp.click();
}

function setTrackImage() {
  const inp = document.createElement('input'); inp.type='file'; inp.accept='image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = async e => {
      const t = tracks.find(x => x.id === editingTrackId);
      if (t) {
        t.image = e.target.result;
        await DB.putTrack(t);
        document.getElementById('te-remove-image').style.display = '';
        document.getElementById('te-hide-label-row').style.display = '';
        renderGrid();
      }
    };
    fr.readAsDataURL(f);
  };
  inp.click();
}

async function removeTrackImage() {
  const t = tracks.find(x => x.id === editingTrackId); if (!t) return;
  t.image = null; t.hideLabel = false;
  await DB.putTrack(t);
  document.getElementById('te-remove-image').style.display = 'none';
  document.getElementById('te-hide-label-row').style.display = 'none';
  document.getElementById('te-hide-label').checked = false;
  renderGrid();
  toast('Image removed');
}

/* ── Board editor ───────────────────────────────────────────────────────── */
function openBoardEditor(b) {
  const m = document.getElementById('board-modal');
  m.querySelector('#be-name').value  = b.name;
  m.querySelector('#be-color').value = b.color;
  m.dataset.boardId = b.id;
  m.classList.remove('hidden');
}

async function saveBoard() {
  const m = document.getElementById('board-modal');
  const b = boards.find(x => x.id === m.dataset.boardId); if (!b) return;
  b.name  = m.querySelector('#be-name').value.trim() || b.name;
  b.color = m.querySelector('#be-color').value;
  await DB.putBoard(b); closeModal('board-modal'); renderTabs();
}

async function deleteBoardAction() {
  const m = document.getElementById('board-modal'), id = m.dataset.boardId;
  const bt = await DB.getTracksForBoard(id);
  for (const t of bt) {
    if (t.type !== 'label') { stopTrack(t.id, 0); clearBuffer(t.id); await DB.deleteAudio(t.id); }
    await DB.deleteTrack(t.id);
  }
  await DB.deleteBoard(id);
  boards = boards.filter(b => b.id !== id);
  if (!boards.length) {
    const b = makeBoard('Board 1');
    await DB.putBoard(b);
    boards = [b];
  }
  closeModal('board-modal');
  await switchBoard(boards[0].id);
}

/* ── Defaults ───────────────────────────────────────────────────────────── */
function openDefaults() {
  const m = document.getElementById('defaults-modal');
  m.querySelector('#df-volume').value = defaults.volume;
  document.getElementById('df-vol-val').textContent = Math.round(defaults.volume * 100) + '%';
  m.querySelector('#df-fadein').value   = defaults.fadeIn;
  m.querySelector('#df-fadeout').value  = defaults.fadeOut;
  m.querySelector('#df-autofade').checked = defaults.autoFadeOnStop;
  m.querySelector('#df-autonext').checked = defaults.autoPlayNext;
  m.querySelector('#df-hotkeys').checked  = hotkeysEnabled;
  m.classList.remove('hidden');
}

async function saveDefaults() {
  const m = document.getElementById('defaults-modal');
  defaults.volume         = parseFloat(m.querySelector('#df-volume').value);
  defaults.fadeIn         = parseFloat(m.querySelector('#df-fadein').value);
  defaults.fadeOut        = parseFloat(m.querySelector('#df-fadeout').value);
  defaults.autoFadeOnStop = m.querySelector('#df-autofade').checked;
  defaults.autoPlayNext   = m.querySelector('#df-autonext').checked;
  hotkeysEnabled = m.querySelector('#df-hotkeys').checked;
  await DB.setSetting('defaults', defaults);
  await DB.setSetting('hotkeysEnabled', hotkeysEnabled);
  closeModal('defaults-modal');
  renderGrid();
  toast('Defaults saved');
}

/* ── Waveform + Modal Player ────────────────────────────────────────────── */
let modalCursor = 0, modalPlayRaf = null, _wfPeaks = null;

function secToMmss(s) {
  if (!s || isNaN(s) || s < 0) s = 0;
  return String(Math.floor(s / 60)).padStart(2,'0') + ':' + String(Math.floor(s % 60)).padStart(2,'0');
}
function mmssToSec(str) {
  str = String(str || '0');
  if (str.includes(':')) { const [m,s] = str.split(':'); return (parseInt(m)||0)*60 + (parseFloat(s)||0); }
  return parseFloat(str) || 0;
}

function precomputeWaveform(trackId) {
  const buf = getBuffer(trackId);
  const canvas = document.getElementById('waveform-canvas');
  if (!buf || !canvas) { _wfPeaks = null; return; }
  const W = Math.max(canvas.offsetWidth, 200);
  const data = buf.getChannelData(0);
  const spp = Math.ceil(data.length / W);
  const mins = new Float32Array(W), maxs = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let mn = 0, mx = 0, base = x * spp;
    for (let i = 0; i < spp && base+i < data.length; i++) {
      const v = data[base+i]; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    mins[x] = mn; maxs[x] = mx;
  }
  _wfPeaks = { mins, maxs, W, duration: buf.duration };
}

function drawWaveformForModal(trackId) {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, W, H);
  if (!_wfPeaks) {
    ctx.fillStyle = '#555'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No audio loaded', W/2, H/2); return;
  }
  const { mins, maxs, duration } = _wfPeaks;
  const trimStart = mmssToSec(document.getElementById('te-trimstart')?.value);
  const trimEnd   = mmssToSec(document.getElementById('te-trimend')?.value);
  const startX = (trimStart / duration) * W;
  const endX   = ((duration - trimEnd) / duration) * W;
  const mid = H / 2;
  for (let x = 0; x < W; x++) {
    ctx.strokeStyle = (x >= startX && x <= endX) ? '#0033a0' : '#1a1a3a';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, mid + mins[x]*mid*0.93); ctx.lineTo(x, mid + maxs[x]*mid*0.93); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  if (startX > 0) ctx.fillRect(0, 0, startX, H);
  if (endX < W)   ctx.fillRect(endX, 0, W-endX, H);
  ctx.lineWidth = 2; ctx.strokeStyle = '#39ff14';
  ctx.beginPath(); ctx.moveTo(startX,0); ctx.lineTo(startX,H); ctx.moveTo(endX,0); ctx.lineTo(endX,H); ctx.stroke();
  ctx.fillStyle = '#39ff14'; ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'left';  ctx.fillText(secToMmss(trimStart), startX+3, H-4);
  ctx.textAlign = 'right'; ctx.fillText(secToMmss(duration-trimEnd), endX-3, H-4);
  if (!isPlaying(trackId)) {
    const cx = (modalCursor / duration) * W;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([4,3]); ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,H); ctx.stroke(); ctx.setLineDash([]);
  }
}

function animateModalPlayhead(trackId) {
  const ph = document.getElementById('waveform-playhead');
  if (modalPlayRaf) cancelAnimationFrame(modalPlayRaf);
  function tick() {
    if (!isPlaying(trackId) || editingTrackId !== trackId) {
      if (ph) ph.style.display = 'none';
      document.getElementById('modal-play-btn').textContent = '▶ Play';
      modalPlayRaf = null; return;
    }
    const p = getProgress(trackId);
    if (p && ph) { ph.style.display = 'block'; ph.style.left = (p.progress * 100) + '%'; }
    const trimStart = mmssToSec(document.getElementById('te-trimstart')?.value);
    const timeEl = document.getElementById('modal-time');
    if (timeEl && p && _wfPeaks) timeEl.textContent = secToMmss(trimStart + p.elapsed) + ' / ' + secToMmss(_wfPeaks.duration);
    modalPlayRaf = requestAnimationFrame(tick);
  }
  modalPlayRaf = requestAnimationFrame(tick);
}

function modalPlayPreview() {
  if (!editingTrackId) return;
  if (isPlaying(editingTrackId)) {
    stopTrack(editingTrackId, 0);
    document.getElementById('modal-play-btn').textContent = '▶ Play';
    const ph = document.getElementById('waveform-playhead'); if (ph) ph.style.display = 'none';
    return;
  }
  if (!getBuffer(editingTrackId)) { toast('No audio loaded'); return; }
  const trimStart = mmssToSec(document.getElementById('te-trimstart').value);
  const trimEnd   = mmssToSec(document.getElementById('te-trimend').value);
  const vol = parseFloat(document.getElementById('te-volume').value) || 1;
  stopAll(0);
  playTrack(editingTrackId, {
    volume: vol, fadeIn: 0, fadeOut: 0,
    trimStart: Math.max(trimStart, modalCursor), trimEnd,
    onEnd: () => {
      document.getElementById('modal-play-btn').textContent = '▶ Play';
      const ph = document.getElementById('waveform-playhead'); if (ph) ph.style.display = 'none';
      render();
    }
  });
  document.getElementById('modal-play-btn').textContent = '■ Stop';
  animateModalPlayhead(editingTrackId);
}

function setModalTrimStart() {
  const inp = document.getElementById('te-trimstart');
  if (inp) { inp.value = secToMmss(modalCursor); drawWaveformForModal(editingTrackId); }
}
function setModalTrimEnd() {
  if (!_wfPeaks) return;
  const inp = document.getElementById('te-trimend');
  if (inp) { inp.value = secToMmss(Math.max(0, _wfPeaks.duration - modalCursor)); drawWaveformForModal(editingTrackId); }
}
function onWaveformClick(e) {
  if (!_wfPeaks) return;
  const canvas = document.getElementById('waveform-canvas');
  const rect = canvas.getBoundingClientRect();
  const clientX = e.clientX !== undefined ? e.clientX : e.touches[0].clientX;
  modalCursor = Math.max(0, Math.min(((clientX - rect.left) / rect.width) * _wfPeaks.duration, _wfPeaks.duration));
  const timeEl = document.getElementById('modal-time');
  if (timeEl) timeEl.textContent = secToMmss(modalCursor) + ' / ' + secToMmss(_wfPeaks.duration);
  if (isPlaying(editingTrackId)) { stopTrack(editingTrackId, 0); modalPlayPreview(); }
  else drawWaveformForModal(editingTrackId);
}

/* ── Global wiring ──────────────────────────────────────────────────────── */
function setupGlobal() {
  const fi = document.getElementById('file-input');
  fi.onchange = () => { handleFiles(fi.files); fi.value = ''; };

  document.getElementById('btn-import-header').onclick = () => fi.click();
  document.getElementById('btn-add-label').onclick     = createLabel;
  document.getElementById('btn-defaults').onclick      = openDefaults;
  document.getElementById('btn-reset').onclick         = resetAllPlayed;
  document.getElementById('btn-edit-done').onclick     = exitEditMode;
  document.getElementById('btn-mute').onclick          = muteAll;

  document.body.ondragover = e => e.preventDefault();
  document.body.ondrop = e => {
    e.preventDefault();
    if (!dragTileId && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  };

  document.querySelectorAll('.modal').forEach(m => { m.onclick = e => { if (e.target === m) closeModal(m.id); }; });

  document.getElementById('te-save').onclick          = saveTrack;
  document.getElementById('te-delete').onclick        = deleteTrackAction;
  document.getElementById('te-replace-audio').onclick = replaceAudio;
  document.getElementById('te-normalize').onclick     = normalizeCurrent;
  document.getElementById('te-add-image').onclick     = setTrackImage;
  document.getElementById('te-remove-image').onclick  = removeTrackImage;
  document.getElementById('te-duplicate').onclick     = duplicateTrack;
  document.getElementById('be-save').onclick          = saveBoard;
  document.getElementById('be-export').onclick        = exportBoard;
  document.getElementById('be-github').onclick        = exportBoardForGithub;
  document.getElementById('be-import-btn').onclick    = () => document.getElementById('board-import-input').click();
  const bii = document.getElementById('board-import-input');
  bii.onchange = () => { if (bii.files[0]) { importBoard(bii.files[0]); bii.value = ''; } };
  document.getElementById('be-import-url').onclick    = importBoardFromUrl;
  document.getElementById('be-delete').onclick        = deleteBoardAction;
  document.getElementById('df-save').onclick          = saveDefaults;
  document.getElementById('modal-play-btn').onclick   = modalPlayPreview;
  document.getElementById('modal-set-start').onclick  = setModalTrimStart;
  document.getElementById('modal-set-end').onclick    = setModalTrimEnd;

  const wfc = document.getElementById('waveform-canvas');
  wfc.addEventListener('click', onWaveformClick);
  wfc.addEventListener('touchstart', e => { e.preventDefault(); onWaveformClick(e); }, { passive: false });

  document.querySelectorAll('.modal-close').forEach(btn => { btn.onclick = () => closeModal(btn.closest('.modal').id); });

  // Hotkey capture input
  const hotkeyInput = document.getElementById('te-hotkey');
  hotkeyInput.addEventListener('keydown', e => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Delete') {
      hotkeyInput.value = ''; hotkeyInput.dataset.capturedKey = ''; return;
    }
    hotkeyInput.value = e.key === ' ' ? 'Space' : e.key;
    hotkeyInput.dataset.capturedKey = e.key;
  });
  hotkeyInput.addEventListener('focus', () => { hotkeyInput.placeholder = 'Press any key…'; });
  hotkeyInput.addEventListener('blur',  () => { hotkeyInput.placeholder = 'Click, then press a key'; });
  document.getElementById('te-hotkey-clear').onclick = () => {
    hotkeyInput.value = ''; hotkeyInput.dataset.capturedKey = '';
  };

  document.addEventListener('keydown', handleHotkey, true); // capture phase — fires before any child stopPropagation
  window.addEventListener('resize', () => renderGrid());

  // Prevent iPad screen from dimming/sleeping while app is open
  requestWakeLock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  // Logo click to replace
  document.getElementById('header-logo').onclick = () => document.getElementById('logo-input').click();
  const li = document.getElementById('logo-input');
  li.onchange = () => {
    const f = li.files[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = e => { localStorage.setItem('logo', e.target.result); document.getElementById('header-logo').src = e.target.result; };
    fr.readAsDataURL(f); li.value = '';
  };
  const savedLogo = localStorage.getItem('logo');
  if (savedLogo) document.getElementById('header-logo').src = savedLogo;
}

/* ── Hotkeys ────────────────────────────────────────────────────────────── */
function handleHotkey(e) {
  if (!hotkeysEnabled) return;
  // Skip modifier-only keypresses
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
  // Skip when typing in a form field
  const el = document.activeElement;
  if (el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (el.isContentEditable) return;
  }
  // Skip when any modal is open (check class list directly for reliability)
  const modals = document.querySelectorAll('.modal');
  for (const m of modals) { if (!m.classList.contains('hidden')) return; }

  const t = tracks.find(x => x.type !== 'label' && x.hotkey &&
    x.hotkey.toLowerCase() === e.key.toLowerCase());
  if (!t) return;
  e.preventDefault();
  // Create AudioContext here (inside a user gesture) if it doesn't exist yet,
  // then wait for resume() before playing — handles suspended/interrupted on all browsers.
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (_ctx.state !== 'running') {
    _ctx.resume().then(() => tapTile(t)).catch(() => tapTile(t));
  } else {
    tapTile(t);
  }
}

/* ── Helpers ────────────────────────────────────────────────────────────── */
function closeModal(id) {
  if (id === 'track-modal' && editingTrackId && isPlaying(editingTrackId)) {
    stopTrack(editingTrackId, 0); render();
  }
  if (modalPlayRaf) { cancelAnimationFrame(modalPlayRaf); modalPlayRaf = null; }
  document.getElementById(id).classList.add('hidden');
  editingTrackId = null;
}
function fmt(s) { return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0'); }
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

/* ── Wake Lock ──────────────────────────────────────────────────────────── */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch (_) {}
}

/* ── Mute All ───────────────────────────────────────────────────────────── */
function muteAll() {
  if (!getActiveIds().length) return;
  stopAll(1.5);
  render();
}

/* ── Volume Normalization ───────────────────────────────────────────────── */
function normalizeVolume(buffer) {
  if (!buffer) return defaults.volume || 1;
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
  }
  if (peak === 0) return defaults.volume || 1;
  return Math.min(0.89 / peak, 1); // target ~-1 dBFS, cap at 1.0
}

function normalizeCurrent() {
  const buf = getBuffer(editingTrackId);
  if (!buf) { toast('No audio loaded'); return; }
  const vol = normalizeVolume(buf);
  document.getElementById('te-volume').value = vol;
  document.getElementById('te-vol-val').textContent = Math.round(vol * 100) + '%';
  toast('Set to ' + Math.round(vol * 100) + '% — click Save to apply');
}

/* ── Duplicate Track ────────────────────────────────────────────────────── */
async function duplicateTrack() {
  const src = tracks.find(x => x.id === editingTrackId); if (!src) return;
  const pos = nextGridPos();
  const newId = uid();
  const copy = { ...src, id: newId, gridCol: pos.col, gridRow: pos.row, hasPlayed: false, order: tracks.length };
  await DB.putTrack(copy);
  if (src.type !== 'label') {
    const audio = await DB.getAudio(src.id);
    if (audio) { await DB.putAudio(newId, audio.blob); await decodeAudio(newId, audio.blob); }
  }
  tracks.push(copy);
  closeModal('track-modal');
  renderGrid();
  toast('Track duplicated');
}

/* ── Export Board ───────────────────────────────────────────────────────── */
async function exportBoard() {
  const board = boards.find(b => b.id === currentBoardId); if (!board) return;
  toast('Exporting…');
  const exportTracks = [];
  for (const t of tracks) {
    let audioData = null;
    if (t.type !== 'label') {
      const rec = await DB.getAudio(t.id);
      if (rec && rec.blob) {
        audioData = await new Promise(resolve => {
          const fr = new FileReader();
          fr.onload = e => resolve(e.target.result);
          fr.readAsDataURL(rec.blob);
        });
      }
    }
    exportTracks.push({ ...t, audioData });
  }
  const blob = new Blob([JSON.stringify({
    format: 'stampede-board-v1',
    exportedAt: new Date().toISOString(),
    board: { name: board.name, color: board.color },
    tracks: exportTracks
  })], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = board.name.replace(/[^a-z0-9]/gi, '_') + '_board.json';
  a.click();
  URL.revokeObjectURL(url);
  closeModal('board-modal');
  toast('Exported: ' + board.name);
}

/* ── Import Board ───────────────────────────────────────────────────────── */
async function importBoard(source) {
  toast('Importing…');
  try {
    const data = (source instanceof File) ? JSON.parse(await source.text()) : source;
    if (!data.board || !data.tracks) { toast('Invalid board file'); return; }
    const newBoard = makeBoard(data.board.name);
    newBoard.color = data.board.color || '#16213e';
    await DB.putBoard(newBoard);
    boards.push(newBoard);
    for (const src of data.tracks) {
      const newId = uid();
      const newTrack = { ...src, id: newId, boardId: newBoard.id, hasPlayed: false };
      delete newTrack.audioData; delete newTrack.audioUrl;
      await DB.putTrack(newTrack);
      if (src.type !== 'label') {
        if (src.audioUrl) {
          try {
            const r = await fetch(src.audioUrl);
            if (r.ok) { const b = await r.blob(); await DB.putAudio(newId, b); await decodeAudio(newId, b); }
          } catch (_) {}
        } else if (src.audioData) {
          const r = await fetch(src.audioData);
          const b = await r.blob();
          await DB.putAudio(newId, b); await decodeAudio(newId, b);
        }
      }
    }
    await switchBoard(newBoard.id);
    closeModal('board-modal');
    toast('Imported: ' + newBoard.name);
  } catch (e) {
    toast('Import failed — check file');
    console.error(e);
  }
}

/* ── Import Board from a named URL (e.g. board-two.json) ────────────────── */
async function importBoardFromUrl() {
  const url = prompt('Board JSON URL or filename (e.g. board-two.json):');
  if (!url || !url.trim()) return;
  toast('Fetching…');
  try {
    const res = await fetch(url.trim());
    if (!res.ok) { toast('Could not fetch — check the URL'); return; }
    const data = await res.json();
    await importBoard(data);
  } catch (e) {
    toast('Import failed — check URL');
    console.error(e);
  }
}

/* ── Auto-load from server (first visit on new device) ─────────────────── */
async function tryAutoLoad() {
  try {
    const res = await fetch('./board.json');
    if (!res.ok) return; // no board.json on server — skip silently
    toast('Loading board from server…');
    const data = await res.json();
    if (!data.board || !data.tracks) return;
    // Reuse the empty default board rather than creating a duplicate tab
    const board = boards[0];
    board.name = data.board.name;
    board.color = data.board.color || '#16213e';
    await DB.putBoard(board);
    let loaded = 0;
    for (const src of data.tracks) {
      const newId = uid();
      const newTrack = { ...src, id: newId, boardId: board.id, hasPlayed: false };
      delete newTrack.audioData; delete newTrack.audioUrl;
      await DB.putTrack(newTrack);
      if (src.type !== 'label') {
        const url = src.audioUrl || null;
        if (url) {
          try {
            const r = await fetch(url);
            if (r.ok) { const b = await r.blob(); await DB.putAudio(newId, b); await decodeAudio(newId, b); loaded++; }
          } catch (_) {}
        } else if (src.audioData) {
          const r = await fetch(src.audioData);
          const b = await r.blob();
          await DB.putAudio(newId, b); await decodeAudio(newId, b); loaded++;
        }
      }
    }
    await loadBoard(board.id);
    render();
    toast('Board loaded — ' + loaded + ' tracks ready');
  } catch (_) {}
}

/* ── Export for GitHub (URL-based, no embedded audio) ───────────────────── */
async function exportBoardForGithub() {
  const board = boards.find(b => b.id === currentBoardId); if (!board) return;
  const missing = tracks.filter(t => t.type !== 'label' && !t.audioFile);
  if (missing.length) {
    toast(missing.length + ' track(s) have no filename — open each ⚙ and use Replace Audio first');
    return;
  }
  const exportTracks = tracks.map(t => {
    const copy = { ...t };
    if (t.type !== 'label' && t.audioFile) copy.audioUrl = 'audio/' + t.audioFile;
    return copy;
  });
  const blob = new Blob([JSON.stringify({
    format: 'stampede-board-v1',
    exportedAt: new Date().toISOString(),
    board: { name: board.name, color: board.color },
    tracks: exportTracks
  }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'board.json';
  a.click(); URL.revokeObjectURL(url);
  closeModal('board-modal');
  toast('board.json downloaded — upload it + audio/ folder to GitHub');
}

/* ── Tag Filter ─────────────────────────────────────────────────────────── */
function setFilter(tag) {
  activeFilter = (activeFilter === tag) ? null : tag;
  renderFilterBar();
  renderGrid();
}

function renderFilterBar() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  const tagSet = new Set();
  tracks.forEach(t => (t.tags || []).forEach(tag => tagSet.add(tag)));
  if (tagSet.size === 0) { bar.innerHTML = ''; return; }
  const allChip = `<button class="filter-chip${activeFilter === null ? ' active' : ''}" onclick="setFilter(null)">All</button>`;
  const chips = [...tagSet].sort().map(tag =>
    `<button class="filter-chip${activeFilter === tag ? ' active' : ''}" onclick="setFilter(${JSON.stringify(tag)})">${tag}</button>`
  ).join('');
  bar.innerHTML = allChip + chips;
}

/* ── Boot ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
