// Web Audio engine — low latency playback with fade, trim, volume

let ctx;

export function getContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Decoded buffer cache: trackId -> AudioBuffer
const bufferCache = new Map();

export async function decodeAudio(trackId, blob) {
  const ac = getContext();
  const arr = await blob.arrayBuffer();
  const buf = await ac.decodeAudioData(arr);
  bufferCache.set(trackId, buf);
  return buf;
}

export function getBuffer(trackId) {
  return bufferCache.get(trackId) || null;
}

export function clearBuffer(trackId) {
  bufferCache.delete(trackId);
}

// Active playback state: trackId -> { source, gainNode, startTime, startOffset, fadeOutTimer }
const active = new Map();

export function isPlaying(trackId) {
  return active.has(trackId);
}

export function getPlaybackProgress(trackId) {
  if (!active.has(trackId)) return null;
  const { startTime, startOffset, duration } = active.get(trackId);
  const elapsed = getContext().currentTime - startTime + startOffset;
  return { elapsed, duration, progress: Math.min(elapsed / duration, 1) };
}

/**
 * Play a track.
 * @param {string} trackId
 * @param {object} opts - { volume, fadeIn, fadeOut, trimStart, trimEnd, onEnd }
 */
export function playTrack(trackId, opts = {}) {
  stopTrack(trackId, 0); // stop any existing playback instantly

  const buf = bufferCache.get(trackId);
  if (!buf) return false;

  const ac = getContext();
  const {
    volume = 1,
    fadeIn = 0,
    fadeOut = 0,
    trimStart = 0,
    trimEnd = 0,
    onEnd
  } = opts;

  const trimmedDuration = buf.duration - trimStart - trimEnd;
  if (trimmedDuration <= 0) return false;

  const gain = ac.createGain();
  gain.connect(ac.destination);

  const source = ac.createBufferSource();
  source.buffer = buf;
  source.connect(gain);

  const now = ac.currentTime;

  // Fade in
  if (fadeIn > 0) {
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + fadeIn);
  } else {
    gain.gain.setValueAtTime(volume, now);
  }

  // Schedule fade out
  let fadeOutTimer = null;
  if (fadeOut > 0) {
    const fadeStart = trimmedDuration - fadeOut;
    if (fadeStart > 0) {
      const delay = (fadeStart - (fadeIn > 0 ? 0 : 0)) * 1000;
      fadeOutTimer = setTimeout(() => {
        if (!active.has(trackId)) return;
        const { gainNode } = active.get(trackId);
        const t = ac.currentTime;
        gainNode.gain.setValueAtTime(gainNode.gain.value, t);
        gainNode.gain.linearRampToValueAtTime(0, t + fadeOut);
      }, Math.max(0, fadeStart * 1000));
    }
  }

  source.start(now, trimStart, trimmedDuration);

  source.onended = () => {
    if (fadeOutTimer) clearTimeout(fadeOutTimer);
    active.delete(trackId);
    if (onEnd) onEnd(trackId);
  };

  active.set(trackId, {
    source,
    gainNode: gain,
    startTime: now,
    startOffset: trimStart,
    duration: trimmedDuration,
    fadeOutTimer,
    volume,
    fadeIn,
    fadeOut
  });

  return true;
}

/**
 * Stop a track, optionally with a fade-out duration.
 */
export function stopTrack(trackId, fadeDuration = 0) {
  if (!active.has(trackId)) return;
  const { source, gainNode, fadeOutTimer } = active.get(trackId);
  if (fadeOutTimer) clearTimeout(fadeOutTimer);

  const ac = getContext();
  const now = ac.currentTime;

  if (fadeDuration > 0) {
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(0, now + fadeDuration);
    try { source.stop(now + fadeDuration); } catch (_) {}
  } else {
    gainNode.gain.setValueAtTime(0, now);
    try { source.stop(now + 0.01); } catch (_) {}
  }

  active.delete(trackId);
}

export function stopAll(fadeDuration = 0) {
  for (const id of [...active.keys()]) stopTrack(id, fadeDuration);
}

export function setVolume(trackId, volume) {
  if (!active.has(trackId)) return;
  const { gainNode } = active.get(trackId);
  gainNode.gain.setValueAtTime(volume, getContext().currentTime);
}

export function getActiveTrackIds() {
  return [...active.keys()];
}
