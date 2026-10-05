// Synthesized with the Web Audio API, so there are no audio files to license.
// The AudioContext starts on the first user gesture (required on iOS).

let ctx = null;
let enabled = true;

export function setSoundEnabled(on) {
  enabled = on;
}

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function ready() {
  return enabled && ctx && ctx.state === 'running';
}

let noiseBuf = null;
function noise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

// A piece landing on wood: filtered noise click plus a short low thump.
function knock({ freq = 1800, q = 1.2, gain = 0.6, decay = 0.07, thump = 140, at = 0 } = {}) {
  const t = ctx.currentTime + at;

  const src = noise();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t);
  src.stop(t + decay + 0.02);

  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(thump, t);
  osc.frequency.exponentialRampToValueAtTime(thump * 0.5, t + 0.08);
  const og = ctx.createGain();
  og.gain.setValueAtTime(gain * 0.8, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  osc.connect(og).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.1);
}

function tone(freq, { type = 'sine', gain = 0.18, at = 0, dur = 0.18 } = {}) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sound = {
  move() {
    if (ready()) knock();
  },
  capture() {
    if (!ready()) return;
    knock({ freq: 1100, gain: 0.8, decay: 0.1, thump: 110 });
    knock({ freq: 2200, gain: 0.35, decay: 0.05, at: 0.035 });
  },
  check() {
    if (!ready()) return;
    knock();
    tone(988, { at: 0.03, gain: 0.12, dur: 0.22 });
  },
  mate() {
    if (!ready()) return;
    knock({ gain: 0.7 });
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone(f, { type: 'triangle', at: 0.08 + i * 0.09, gain: 0.2, dur: 0.35 }),
    );
  },
  wrong() {
    if (!ready()) return;
    tone(233, { type: 'square', gain: 0.06, dur: 0.12 });
    tone(196, { type: 'square', gain: 0.06, at: 0.12, dur: 0.2 });
  },
};
