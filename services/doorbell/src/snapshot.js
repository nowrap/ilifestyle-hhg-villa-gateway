'use strict';

const { spawn } = require('node:child_process');

// Measured on AVL20P firmware 4.1.5 with two door cameras: after power-on the
// gateway first streams its blue "no signal" screen, then freezes for ~2 s,
// then emits torn or overexposed transition frames before exposure settles.
// Neither the first decodable frame nor a JPEG size threshold is therefore a
// reliable indicator of a usable picture.

const DEFAULTS = Object.freeze({
  stableMs: 500,
  maxWaitMs: 4000,
  lumaRange: 3,
  maxGapMs: 200,
  minStableFrames: 8,
  blueChroma: 40,
  cropRight: 10,
  enhance: true,
  hazeThreshold: 30,
});

// Luma mean, 10th luma percentile and mean chroma deviation of a yuv420p frame.
// The analog decoder adds a black border on the right that must not count.
function frameStats(frame, width, height, cropRight = 0, step = 2) {
  const usableWidth = Math.max(1, width - cropRight);
  const histogram = new Uint32Array(256);
  let lumaSum = 0;
  let samples = 0;
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < usableWidth; x += step) {
      const value = frame[row + x];
      histogram[value] += 1;
      lumaSum += value;
      samples += 1;
    }
  }
  const lowTarget = samples * 0.1;
  let cumulative = 0;
  let ylow = 0;
  for (; ylow < 255; ylow += 1) {
    cumulative += histogram[ylow];
    if (cumulative >= lowTarget) break;
  }

  const chromaWidth = width >> 1;
  const chromaHeight = height >> 1;
  const uOffset = width * height;
  const vOffset = uOffset + chromaWidth * chromaHeight;
  const usableChromaWidth = Math.max(1, (usableWidth >> 1));
  let uSum = 0;
  let vSum = 0;
  let chromaSamples = 0;
  for (let y = 0; y < chromaHeight; y += step) {
    const row = y * chromaWidth;
    for (let x = 0; x < usableChromaWidth; x += step) {
      uSum += frame[uOffset + row + x];
      vSum += frame[vOffset + row + x];
      chromaSamples += 1;
    }
  }
  const chroma = Math.abs(uSum / chromaSamples - 128) + Math.abs(vSum / chromaSamples - 128);
  return { yavg: lumaSum / samples, ylow, chroma };
}

// Chooses the newest frame of the first gap-free, non-blue window of
// `stableMs` whose mean luma varies by less than `lumaRange`. Frames are
// described by their presentation time, so a frozen decoder shows up as a gap
// instead of as a convincingly "stable" picture.
class StableFrameSelector {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.run = [];
  }

  push(frame) {
    const { blueChroma, maxGapMs, stableMs, lumaRange, minStableFrames } = this.options;
    if (!Number.isFinite(frame.ptsMs) || frame.chroma > blueChroma) {
      this.run = [];
      return null;
    }
    const previous = this.run.at(-1);
    if (previous && (frame.ptsMs <= previous.ptsMs || frame.ptsMs - previous.ptsMs > maxGapMs)) this.run = [];
    this.run.push(frame);
    while (this.run.length > 1 && this.run[1].ptsMs <= frame.ptsMs - stableMs) this.run.shift();
    if (this.run[0].ptsMs > frame.ptsMs - stableMs || this.run.length < minStableFrames) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const item of this.run) {
      if (item.yavg < min) min = item.yavg;
      if (item.yavg > max) max = item.yavg;
    }
    return max - min < lumaRange ? frame : null;
  }

  // Best effort after the wait budget: the newest frame of a short gap-free
  // run is still preferable to the blue screen or a text-only notification.
  fallback() {
    return this.run.length >= 3 ? this.run.at(-1) : null;
  }
}

// Raises the black point of hazy (backlit) pictures and leaves normally
// exposed ones alone. The correction grows with the measured haze.
function hazeCurve(ylow, threshold = DEFAULTS.hazeThreshold) {
  if (!Number.isFinite(ylow) || ylow <= threshold) return null;
  const blackPoint = Math.min(0.35, (ylow / 255) * 0.6);
  const points = [[0, 0], [blackPoint, 0.02]];
  for (const fraction of [0.25, 0.55, 0.85]) {
    points.push([blackPoint + (1 - blackPoint) * fraction, fraction ** 1.25]);
  }
  points.push([1, 1]);
  return points.map(([x, y]) => `${Number(x.toFixed(3))}/${Number(y.toFixed(3))}`).join(' ');
}

function enhancementFilter({ ylow, cropRight = DEFAULTS.cropRight, enhance = DEFAULTS.enhance, hazeThreshold }) {
  const filters = [];
  const curve = enhance ? hazeCurve(ylow, hazeThreshold) : null;
  if (cropRight > 0) filters.push(`crop=iw-${cropRight}:ih:0:0`);
  if (curve) filters.push(`curves=all='${curve}'`, 'eq=saturation=1.5');
  if (enhance) filters.push('unsharp=5:5:0.5');
  return { filter: filters.join(',') || 'null', curve };
}

function parseShowinfo(line) {
  const match = /\bn:\s*(\d+)\b.*\bpts_time:\s*(-?[\d.]+)/.exec(line);
  if (!match) return null;
  const size = /\bs:(\d+)x(\d+)\b/.exec(line);
  return {
    index: Number(match[1]),
    ptsMs: Number(match[2]) * 1000,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
  };
}

// Reads raw frames until a stable picture is found (or the wait budget runs
// out) and stops the RTSP session immediately afterwards.
function selectStableFrame({ url, ffmpegPath = 'ffmpeg', inputArgs = [], options = {} }) {
  const settings = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-loglevel', 'info'];
    if (/^rtsps?:/i.test(url)) args.push('-rtsp_transport', 'tcp');
    args.push(...inputArgs, '-i', url, '-an', '-vf', 'showinfo', '-fps_mode', 'passthrough',
      '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1');
    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const selector = new StableFrameSelector(settings);
    const timings = [];
    let pending = Buffer.alloc(0);
    let stderrLine = '';
    let stderrTail = '';
    let width = null;
    let height = null;
    let frames = 0;
    let latest = null;
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ffmpeg.kill('SIGKILL');
      if (error) reject(error);
      else resolve({ ...result, width, height, frames, waitedMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      const fallback = selector.fallback();
      if (fallback) finish(null, { ...fallback, stable: false });
      else finish(new Error(`no usable frame within ${settings.maxWaitMs} ms (${frames} frames)`));
    }, settings.maxWaitMs);

    const consume = () => {
      if (!width || !height) return;
      const frameSize = width * height * 1.5;
      while (pending.length >= frameSize && timings.length > 0) {
        const data = Buffer.from(pending.subarray(0, frameSize));
        pending = pending.subarray(frameSize);
        const timing = timings.shift();
        frames += 1;
        const stats = frameStats(data, width, height, settings.cropRight);
        latest = { ...timing, ...stats, data };
        const chosen = selector.push(latest);
        if (chosen) return finish(null, { ...chosen, stable: true });
      }
      return undefined;
    };

    ffmpeg.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      consume();
    });
    ffmpeg.stderr.on('data', (chunk) => {
      stderrLine += chunk.toString();
      const lines = stderrLine.split(/\r?\n/);
      stderrLine = lines.pop();
      for (const line of lines) {
        const info = parseShowinfo(line);
        if (!info) {
          if (line.trim()) stderrTail = `${stderrTail}\n${line}`.slice(-300);
          continue;
        }
        if (!width && info.width) ({ width, height } = info);
        timings.push({ index: info.index, ptsMs: info.ptsMs });
      }
      consume();
    });
    ffmpeg.on('error', (error) => finish(error));
    ffmpeg.on('close', (code, signal) => {
      if (settled) return;
      const fallback = selector.fallback();
      if (fallback) finish(null, { ...fallback, stable: false });
      else finish(new Error(`ffmpeg ${signal || code} before a usable frame: ${stderrTail.trim()}`));
    });
  });
}

function encodeFrame({ frame, width, height, path, filter, ffmpegPath = 'ffmpeg', timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
      '-s', `${width}x${height}`, '-i', 'pipe:0', '-vf', filter, '-frames:v', '1', '-q:v', '2', '-y', path,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => ffmpeg.kill('SIGKILL'), timeoutMs);
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    ffmpeg.on('error', (error) => { clearTimeout(timer); reject(error); });
    ffmpeg.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg encode ${signal || code}: ${stderr.slice(-300)}`));
    });
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stdin.end(frame);
  });
}

async function captureStableSnapshot({ url, path, ffmpegPath, inputArgs, options = {} }) {
  const settings = { ...DEFAULTS, ...options };
  const selected = await selectStableFrame({ url, ffmpegPath, inputArgs, options: settings });
  const { filter, curve } = enhancementFilter({
    ylow: selected.ylow, cropRight: settings.cropRight, enhance: settings.enhance, hazeThreshold: settings.hazeThreshold,
  });
  const encodeStartedAt = Date.now();
  await encodeFrame({ frame: selected.data, width: selected.width, height: selected.height, path, filter, ffmpegPath });
  return {
    stable: selected.stable,
    frames: selected.frames,
    ptsMs: Math.round(selected.ptsMs),
    waitedMs: selected.waitedMs,
    encodeMs: Date.now() - encodeStartedAt,
    yavg: Math.round(selected.yavg),
    ylow: selected.ylow,
    curve,
  };
}

module.exports = {
  DEFAULTS, frameStats, StableFrameSelector, hazeCurve, enhancementFilter, parseShowinfo,
  selectStableFrame, encodeFrame, captureStableSnapshot,
};
