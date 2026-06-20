import * as DB from './db.js';
import * as Audio from './audio.js';

// ── State ──────────────────────────────────────────────────────────────────
let boards = [];
let currentBoardId = null;
let tracks = [];      // tracks for current board
let defaults = {};    // default track settings
let dragSrc = null;   // track being dragged
let editingTrackId = null;

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  await DB.openDB();
  defaults = (await DB.getSetting('defaults')) || {
    volume: 1, fadeIn: 0, fadeOut: 3,
    trimStart: 0, trimEnd: 0,
    autoFadeOnStop: true, autoPlayNext: false
  };

  boards = await DB.getBoards();
  boards.sort((a, b) => a.order - b.order);

  if (boards.length === 0) {
    const b = makeBoard('Board 1');
    await DB.putBoard(b);
    boards = [b];
  }

  currentBoardId = boards[0].id;
  await loadBoard(currentBoardId);
  render();
  setupGlobal();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }
}

// ── Factories ──────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

function makeBoard(name) {
  return { id: uid(), name, color: '#16213e', order: boards.length };
}

function makeTrack(name) {
  return {
    id: uid(), boardId: currentBoardId, name,
    color: '#0f3460', image: null, order: tracks.length,
    volume: defaults.volume, fadeIn: defaults.fadeIn, fadeOut: defaults.fadeOut,
    trimStart: defaults.trimStart, trimEnd: defaults.trimEnd,
    autoFadeOnStop: defaults.autoFadeOnStop, autoPlayNext: defaults.autoPlayNext,
    hasPlayed: false
  };
}

// ── Board loading ──────────────────────────────────────────────────────────
async function loadBoard(boardId) {
  currentBoardId = boardId;
  tracks = await DB.getTracksForBoard(boardId);
  tracks.sort((a, b) => a.order - b.order);
  // Pre-load audio buffers for this board
  for (const t of tracks) {
    if (!Audio.getBuffer(t.id)) {
      const rec = await DB.getAudio(t.id);
      if (rec) await Audio.decodeAudio(t.id, rec.blob);
    }
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────
function render() {
  renderBoardTabs();
  renderGrid();
  renderNowPlaying();
}

function renderBoardTabs() {
  const bar = document.getElementById('board-tabs');
  bar.innerHTML = '';
  boards.forEach(b => {
    const tab = document.createElement('button');
    tab.className = 'board-tab' + (b.id === currentBoardId ? ' active' : '');
    tab.textContent = b.name;
    tab.style.borderBottomColor = b.color;
    tab.onclick = () => switchBoard(b.id);
    tab.oncontextmenu = e => { e.preventDefault(); openBoardEditor(b); };
    bar.appendChild(tab);
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
  tracks.forEach((t, i) => {
    const tile = buildTile(t, i);
    grid.appendChild(tile);
  });

  // Import tile
  const imp = document.createElement('div');
  imp.className = 'track-tile import-tile';
  imp.innerHTML = '<span class="import-icon">+</span><span>Import</span>';
  imp.onclick = () => document.getElementById('file-input').click();
  imp.ondragover = e => { e.preventDefault(); imp.classList.add('drag-over'); };
  imp.ondragleave = () => imp.classList.remove('drag-over');
  imp.ondrop = e => { e.preventDefault(); imp.classList.remove('drag-over'); handleFileDrop(e.dataTransfer.files); };
  grid.appendChild(imp);
}

function buildTile(t, i) {
  const playing = Audio.isPlaying(t.id);
  const tile = document.createElement('div');
  tile.className = 'track-tile' + (playing ? ' playing' : '') + (t.hasPlayed && !playing ? ' played' : '');
  tile.dataset.id = t.id;
  tile.style.backgroundColor = t.color;
  tile.draggable = true;

  if (t.image) {
    const img = document.createElement('img');
    img.src = t.image;
    img.className = 'tile-image';
    tile.appendChild(img);
  }

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = t.name;
  tile.appendChild(label);

  if (playing) {
    const prog = document.createElement('div');
    prog.className = 'tile-progress';
    prog.id = 'prog-' + t.id;
    tile.appendChild(prog);
    updateProgress(t.id);
  }

  const settBtn = document.createElement('button');
  settBtn.className = 'tile-settings-btn';
  settBtn.innerHTML = '⚙';
  settBtn.onclick = e => { e.stopPropagation(); openTrackEditor(t); };
  tile.appendChild(settBtn);

  tile.onclick = () => handleTileTap(t);

  // Drag & drop reorder
  tile.ondragstart = e => { dragSrc = t.id; e.dataTransfer.effectAllowed = 'move'; };
  tile.ondragover = e => { e.preventDefault(); tile.classList.add('drag-over'); };
  tile.ondragleave = () => tile.classList.remove('drag-over');
  tile.ondrop = e => { e.preventDefault(); tile.classList.remove('drag-over'); handleTileReorder(t.id); };
  tile.ondragend = () => { dragSrc = null; document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); };

  return tile;
}

// ── Tile tap ───────────────────────────────────────────────────────────────
function handleTileTap(t) {
  if (Audio.isPlaying(t.id)) {
    const fade = t.autoFadeOnStop ? t.fadeOut : 0;
    Audio.stopTrack(t.id, fade);
    renderGrid();
    renderNowPlaying();
    return;
  }

  const ok = Audio.playTrack(t.id, {
    volume: t.volume,
    fadeIn: t.fadeIn,
    fadeOut: t.fadeOut,
    trimStart: t.trimStart,
    trimEnd: t.trimEnd,
    onEnd: trackEnded
  });

  if (!ok) {
    showToast('No audio loaded for this track');
    return;
  }

  t.hasPlayed = true;
  DB.putTrack(t);
  renderGrid();
  renderNowPlaying();
}

function trackEnded(trackId) {
  const t = tracks.find(x => x.id === trackId);
  if (!t) { renderGrid(); renderNowPlaying(); return; }

  if (t.autoPlayNext) {
    const idx = tracks.indexOf(t);
    const next = tracks[idx + 1];
    if (next && Audio.getBuffer(next.id)) {
      handleTileTap(next);
      return;
    }
  }
  renderGrid();
  renderNowPlaying();
}

// ── Progress animation ─────────────────────────────────────────────────────
const progTimers = new Map();

function updateProgress(trackId) {
  if (progTimers.has(trackId)) return;
  function tick() {
    const el = document.getElementById('prog-' + trackId);
    if (!el || !Audio.isPlaying(trackId)) { progTimers.delete(trackId); return; }
    const p = Audio.getPlaybackProgress(trackId);
    if (p) el.style.width = (p.progress * 100) + '%';
    progTimers.set(trackId, requestAnimationFrame(tick));
  }
  progTimers.set(trackId, requestAnimationFrame(tick));
}

// ── Now Playing panel ──────────────────────────────────────────────────────
function renderNowPlaying() {
  const panel = document.getElementById('now-playing');
  const ids = Audio.getActiveTrackIds();
  if (ids.length === 0) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const list = panel.querySelector('.np-list');
  list.innerHTML = '';
  ids.forEach(id => {
    const t = tracks.find(x => x.id === id);
    if (!t) return;
    const row = document.createElement('div');
    row.className = 'np-row';
    row.innerHTML = `
      <span class="np-name">${t.name}</span>
      <input type="range" class="np-vol" min="0" max="1" step="0.01" value="${t.volume}" data-id="${id}">
      <button class="np-stop" data-id="${id}">■</button>
    `;
    row.querySelector('.np-vol').oninput = e => {
      const v = parseFloat(e.target.value);
      Audio.setVolume(id, v);
      t.volume = v;
    };
    row.querySelector('.np-stop').onclick = () => {
      Audio.stopTrack(id, t.autoFadeOnStop ? t.fadeOut : 0);
      renderGrid();
      renderNowPlaying();
    };
    list.appendChild(row);
  });
}

// ── Board switching ────────────────────────────────────────────────────────
async function switchBoard(boardId) {
  await loadBoard(boardId);
  render();
}

async function addBoard() {
  const name = prompt('Board name:');
  if (!name) return;
  const b = makeBoard(name.trim());
  boards.push(b);
  await DB.putBoard(b);
  await switchBoard(b.id);
}

// ── File import ────────────────────────────────────────────────────────────
async function handleFileDrop(files) {
  const audioFiles = [...files].filter(f => f.type.startsWith('audio/'));
  if (audioFiles.length === 0) { showToast('No audio files found'); return; }
  for (const file of audioFiles) await importFile(file);
  renderGrid();
}

async function importFile(file) {
  const t = makeTrack(file.name.replace(/\.[^.]+$/, ''));
  await DB.putTrack(t);
  await DB.putAudio(t.id, file);
  await Audio.decodeAudio(t.id, file);
  tracks.push(t);
}

// ── Drag reorder ───────────────────────────────────────────────────────────
async function handleTileReorder(targetId) {
  if (!dragSrc || dragSrc === targetId) return;
  const from = tracks.findIndex(t => t.id === dragSrc);
  const to = tracks.findIndex(t => t.id === targetId);
  if (from < 0 || to < 0) return;
  tracks.splice(to, 0, tracks.splice(from, 1)[0]);
  tracks.forEach((t, i) => { t.order = i; DB.putTrack(t); });
  renderGrid();
}

// ── Track editor modal ─────────────────────────────────────────────────────
function openTrackEditor(t) {
  editingTrackId = t.id;
  const m = document.getElementById('track-modal');
  m.querySelector('#te-name').value = t.name;
  m.querySelector('#te-color').value = t.color;
  m.querySelector('#te-volume').value = t.volume;
  m.querySelector('#te-fadein').value = t.fadeIn;
  m.querySelector('#te-fadeout').value = t.fadeOut;
  m.querySelector('#te-trimstart').value = t.trimStart;
  m.querySelector('#te-trimend').value = t.trimEnd;
  m.querySelector('#te-autofade').checked = t.autoFadeOnStop;
  m.querySelector('#te-autonext').checked = t.autoPlayNext;

  // Board select
  const sel = m.querySelector('#te-board');
  sel.innerHTML = boards.map(b => `<option value="${b.id}"${b.id === t.boardId ? ' selected' : ''}>${b.name}</option>`).join('');

  // Audio info
  const dur = Audio.getBuffer(t.id)?.duration;
  m.querySelector('#te-duration').textContent = dur ? formatTime(dur) : 'No audio';

  m.classList.remove('hidden');
}

async function saveTrackEditor() {
  const t = tracks.find(x => x.id === editingTrackId);
  if (!t) return;
  const m = document.getElementById('track-modal');

  t.name = m.querySelector('#te-name').value.trim() || t.name;
  t.color = m.querySelector('#te-color').value;
  t.volume = parseFloat(m.querySelector('#te-volume').value);
  t.fadeIn = parseFloat(m.querySelector('#te-fadein').value);
  t.fadeOut = parseFloat(m.querySelector('#te-fadeout').value);
  t.trimStart = parseFloat(m.querySelector('#te-trimstart').value);
  t.trimEnd = parseFloat(m.querySelector('#te-trimend').value);
  t.autoFadeOnStop = m.querySelector('#te-autofade').checked;
  t.autoPlayNext = m.querySelector('#te-autonext').checked;

  const newBoard = m.querySelector('#te-board').value;
  if (newBoard !== t.boardId) {
    t.boardId = newBoard;
    tracks = tracks.filter(x => x.id !== t.id);
  }

  await DB.putTrack(t);
  closeModal('track-modal');
  renderGrid();
}

async function deleteTrack() {
  if (!editingTrackId) return;
  if (!confirm('Delete this track?')) return;
  Audio.stopTrack(editingTrackId, 0);
  Audio.clearBuffer(editingTrackId);
  await DB.deleteTrack(editingTrackId);
  await DB.deleteAudio(editingTrackId);
  tracks = tracks.filter(t => t.id !== editingTrackId);
  closeModal('track-modal');
  renderGrid();
  renderNowPlaying();
}

async function replaceAudio() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'audio/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    await DB.putAudio(editingTrackId, file);
    await Audio.decodeAudio(editingTrackId, file);
    const dur = Audio.getBuffer(editingTrackId)?.duration;
    document.getElementById('te-duration').textContent = dur ? formatTime(dur) : '—';
    showToast('Audio replaced');
  };
  input.click();
}

async function addTrackImage() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async e => {
      const t = tracks.find(x => x.id === editingTrackId);
      if (t) { t.image = e.target.result; await DB.putTrack(t); }
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// ── Board editor modal ─────────────────────────────────────────────────────
function openBoardEditor(b) {
  const m = document.getElementById('board-modal');
  m.querySelector('#be-name').value = b.name;
  m.querySelector('#be-color').value = b.color;
  m.dataset.boardId = b.id;
  m.classList.remove('hidden');
}

async function saveBoardEditor() {
  const m = document.getElementById('board-modal');
  const b = boards.find(x => x.id === m.dataset.boardId);
  if (!b) return;
  b.name = m.querySelector('#be-name').value.trim() || b.name;
  b.color = m.querySelector('#be-color').value;
  await DB.putBoard(b);
  closeModal('board-modal');
  renderBoardTabs();
}

async function deleteBoard() {
  const m = document.getElementById('board-modal');
  const id = m.dataset.boardId;
  if (boards.length <= 1) { showToast('Cannot delete the last board'); return; }
  if (!confirm('Delete this board and all its tracks?')) return;
  const bTracks = await DB.getTracksForBoard(id);
  for (const t of bTracks) {
    Audio.stopTrack(t.id, 0);
    Audio.clearBuffer(t.id);
    await DB.deleteTrack(t.id);
    await DB.deleteAudio(t.id);
  }
  await DB.deleteBoard(id);
  boards = boards.filter(b => b.id !== id);
  closeModal('board-modal');
  await switchBoard(boards[0].id);
}

// ── Defaults modal ─────────────────────────────────────────────────────────
function openDefaults() {
  const m = document.getElementById('defaults-modal');
  m.querySelector('#df-volume').value = defaults.volume;
  m.querySelector('#df-fadein').value = defaults.fadeIn;
  m.querySelector('#df-fadeout').value = defaults.fadeOut;
  m.querySelector('#df-autofade').checked = defaults.autoFadeOnStop;
  m.querySelector('#df-autonext').checked = defaults.autoPlayNext;
  m.classList.remove('hidden');
}

async function saveDefaults() {
  const m = document.getElementById('defaults-modal');
  defaults.volume = parseFloat(m.querySelector('#df-volume').value);
  defaults.fadeIn = parseFloat(m.querySelector('#df-fadein').value);
  defaults.fadeOut = parseFloat(m.querySelector('#df-fadeout').value);
  defaults.autoFadeOnStop = m.querySelector('#df-autofade').checked;
  defaults.autoPlayNext = m.querySelector('#df-autonext').checked;
  await DB.setSetting('defaults', defaults);
  closeModal('defaults-modal');
  showToast('Defaults saved');
}

// ── Global setup ───────────────────────────────────────────────────────────
function setupGlobal() {
  // File input for import
  const fi = document.getElementById('file-input');
  fi.onchange = () => { handleFileDrop(fi.files); fi.value = ''; };

  // Global drag & drop on body
  document.body.ondragover = e => e.preventDefault();
  document.body.ondrop = e => {
    e.preventDefault();
    if (e.dataTransfer.files.length) handleFileDrop(e.dataTransfer.files);
  };

  // Modal close on backdrop click
  document.querySelectorAll('.modal').forEach(m => {
    m.onclick = e => { if (e.target === m) closeModal(m.id); };
  });

  // Now-playing toggle
  document.getElementById('np-toggle').onclick = () => {
    document.getElementById('np-list-wrap').classList.toggle('hidden');
  };

  // Stop all
  document.getElementById('stop-all').onclick = () => {
    Audio.stopAll(0);
    renderGrid();
    renderNowPlaying();
  };

  // Defaults button
  document.getElementById('btn-defaults').onclick = openDefaults;

  // Modal buttons
  document.getElementById('te-save').onclick = saveTrackEditor;
  document.getElementById('te-delete').onclick = deleteTrack;
  document.getElementById('te-replace-audio').onclick = replaceAudio;
  document.getElementById('te-add-image').onclick = addTrackImage;
  document.getElementById('be-save').onclick = saveBoardEditor;
  document.getElementById('be-delete').onclick = deleteBoard;
  document.getElementById('df-save').onclick = saveDefaults;

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.onclick = () => closeModal(btn.closest('.modal').id);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.add('hidden'); editingTrackId = null; }

function formatTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Boot ───────────────────────────────────────────────────────────────────
init().catch(console.error);
