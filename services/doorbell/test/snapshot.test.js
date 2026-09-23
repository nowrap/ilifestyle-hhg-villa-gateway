'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  frameStats, StableFrameSelector, hazeCurve, enhancementFilter, parseShowinfo,
} = require('../src/snapshot');

const WIDTH = 64;
const HEIGHT = 48;

function yuvFrame({ y = 128, u = 128, v = 128, border = 0 }) {
  const frame = Buffer.alloc(WIDTH * HEIGHT * 1.5);
  frame.fill(y, 0, WIDTH * HEIGHT);
  for (let row = 0; row < HEIGHT; row += 1) {
    frame.fill(0, row * WIDTH + WIDTH - border, (row + 1) * WIDTH);
  }
  frame.fill(u, WIDTH * HEIGHT, WIDTH * HEIGHT * 1.25);
  frame.fill(v, WIDTH * HEIGHT * 1.25);
  return frame;
}

// Frame sequence shaped like the measured AVL20P camera start: blue screen,
// a ~1.7 s freeze, one torn transition frame, then settling exposure.
function measuredStart({ blueUntil = 700, freezeMs = 1700, transition = 114, stable = 148 } = {}) {
  const frames = [];
  for (let t = 0; t < blueUntil; t += 25) frames.push({ ptsMs: t, yavg: 64, chroma: 80 });
  let t = blueUntil + freezeMs;
  frames.push({ ptsMs: t, yavg: transition, chroma: 5 });
  for (let i = 0; i < 80; i += 1) {
    t += 25;
    frames.push({ ptsMs: t, yavg: stable + Math.min(i, 20) * 0.05, chroma: 3 });
  }
  return frames;
}

function firstChoice(selector, frames) {
  for (const frame of frames) {
    const chosen = selector.push(frame);
    if (chosen) return chosen;
  }
  return null;
}

test('frame statistics detect the blue no-signal screen', () => {
  const stats = frameStats(yuvFrame({ y: 64, u: 192, v: 112 }), WIDTH, HEIGHT);
  assert.equal(stats.yavg, 64);
  assert.equal(stats.chroma, 80);
  assert.ok(frameStats(yuvFrame({ y: 150, u: 126, v: 128 }), WIDTH, HEIGHT).chroma < 5);
});

test('frame statistics ignore the black decoder border on the right', () => {
  const frame = yuvFrame({ y: 150, border: 10 });
  assert.equal(frameStats(frame, WIDTH, HEIGHT, 10).ylow, 150);
  assert.equal(frameStats(frame, WIDTH, HEIGHT, 0).ylow, 0);
});

test('selector skips blue, frozen and transition frames and picks a settled frame', () => {
  const frames = measuredStart();
  const chosen = firstChoice(new StableFrameSelector(), frames);
  const firstStable = frames.find((frame) => frame.yavg >= 148);
  assert.ok(chosen);
  assert.ok(chosen.yavg >= 148, 'transition frame must not be chosen');
  assert.ok(chosen.ptsMs >= firstStable.ptsMs + 500, 'needs a full stable window');
  assert.ok(chosen.ptsMs <= firstStable.ptsMs + 550, 'must not wait longer than necessary');
});

test('a frozen stream never counts as stable', () => {
  const selector = new StableFrameSelector();
  const frozen = [0, 400, 800, 1200, 1600].map((ptsMs) => ({ ptsMs, yavg: 115, chroma: 5 }));
  assert.equal(firstChoice(selector, frozen), null);
  assert.equal(selector.fallback(), null);
});

test('overexposure that is still settling is rejected until luma stops moving', () => {
  const frames = [];
  let yavg = 240;
  for (let t = 0; t < 3000; t += 25) {
    yavg = t < 1500 ? 240 - t / 20 : 165;
    frames.push({ ptsMs: t, yavg, chroma: 4 });
  }
  const chosen = firstChoice(new StableFrameSelector(), frames);
  assert.equal(chosen.yavg, 165);
  // The window may still contain the last few frames of the ramp as long as
  // their luma differs by less than `lumaRange` (here: 167.5 -> 165).
  assert.ok(chosen.ptsMs >= 1900, `chosen at ${chosen.ptsMs} ms`);
});

test('blue frames inside a run and out-of-order timestamps restart the window', () => {
  const selector = new StableFrameSelector();
  const frames = [];
  for (let t = 0; t < 400; t += 25) frames.push({ ptsMs: t, yavg: 150, chroma: 3 });
  frames.push({ ptsMs: 425, yavg: 64, chroma: 80 });
  frames.push({ ptsMs: 300, yavg: 150, chroma: 3 });
  assert.equal(firstChoice(selector, frames), null);
});

test('fallback returns the newest frame of a short gap-free run only', () => {
  const selector = new StableFrameSelector();
  for (const ptsMs of [0, 25, 50]) selector.push({ ptsMs, yavg: 150 + ptsMs, chroma: 3 });
  assert.equal(selector.fallback().ptsMs, 50);
});

test('haze curve adapts to the measured black level and leaves normal pictures alone', () => {
  assert.equal(hazeCurve(22), null);
  assert.equal(hazeCurve(30), null);
  const north = hazeCurve(43);
  const south = hazeCurve(112);
  assert.match(north, /^0\/0 0\.101\/0\.02 /);
  assert.match(south, /^0\/0 0\.264\/0\.02 /);
  assert.match(hazeCurve(250), /^0\/0 0\.35\/0\.02 /);
  for (const curve of [north, south]) {
    const points = curve.split(' ').map((point) => point.split('/').map(Number));
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i][0] > points[i - 1][0] && points[i][1] > points[i - 1][1], curve);
    }
  }
});

test('enhancement filter can be disabled without losing the border crop', () => {
  assert.equal(enhancementFilter({ ylow: 112, enhance: false }).filter, 'crop=iw-10:ih:0:0');
  assert.equal(enhancementFilter({ ylow: 112, enhance: false, cropRight: 0 }).filter, 'null');
  const enhanced = enhancementFilter({ ylow: 112 });
  assert.match(enhanced.filter, /^crop=iw-10:ih:0:0,curves=all='[^']+',eq=saturation=1\.5,unsharp=5:5:0\.5$/);
  assert.equal(enhancementFilter({ ylow: 20 }).filter, 'crop=iw-10:ih:0:0,unsharp=5:5:0.5');
});

test('showinfo parser extracts frame index, timestamp and size', () => {
  const line = '[Parsed_showinfo_0 @ 0x55] n:  12 pts:  4200 pts_time:0.4666 duration: 90 '
    + 'fmt:yuv420p cl:left sar:0/1 s:640x480 i:P iskey:0 type:P checksum:ABCD';
  assert.deepEqual(parseShowinfo(line), { index: 12, ptsMs: 466.6, width: 640, height: 480 });
  assert.equal(parseShowinfo('[rtsp @ 0x1] method SETUP failed'), null);
});
