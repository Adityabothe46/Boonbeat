// Run: node test/analysis.test.js
// Builds synthetic songs with a known tempo and beat grid and checks the analyzer.
const A = require('../js/analysis.js');

const SR = 22050;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function makeTrack({ bpm, offset, seconds, introSec = 0, outroSec = 0, drums = true, seed = 1 }) {
  const x = new Float32Array(Math.floor(seconds * SR));
  const rand = rng(seed);
  const beat = 60 / bpm;
  const bodyStart = introSec, bodyEnd = seconds - outroSec;
  // pad chords everywhere (quieter in intro/outro)
  const chords = [[220, 277.18, 329.63], [196, 246.94, 293.66], [174.61, 220, 261.63], [196, 261.63, 329.63]];
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const lvl = t < bodyStart || t > bodyEnd ? 0.03 : 0.08;
    const bar = Math.max(0, Math.floor((t - offset) / (4 * beat)));
    const freqs = chords[bar % 4];
    const env = Math.min(1, ((t - offset) % (4 * beat) + 4 * beat) % (4 * beat) / 0.02);
    let v = 0;
    for (const f of freqs) v += env * Math.sin(2 * Math.PI * f * t);
    x[i] += lvl * v / 3;
  }
  if (drums) {
    for (let k = 0; ; k++) {
      const bt = offset + k * beat;
      if (bt >= seconds) break;
      const inBody = bt >= bodyStart && bt <= bodyEnd;
      const s0 = Math.floor(bt * SR);
      // kick (only in body), with slightly stronger downbeat
      if (inBody) {
        const amp = k % 4 === 0 ? 0.9 : 0.7;
        for (let i = 0; i < 0.18 * SR && s0 + i < x.length; i++) {
          const t = i / SR;
          const f = 50 + 90 * Math.exp(-t * 30);
          x[s0 + i] += amp * Math.exp(-t * 18) * Math.sin(2 * Math.PI * f * t);
        }
      }
      // hats on the off-beat always
      const h0 = Math.floor((bt + beat / 2) * SR);
      for (let i = 0; i < 0.03 * SR && h0 + i < x.length; i++) {
        x[h0 + i] += 0.15 * Math.exp(-(i / SR) * 120) * (rand() * 2 - 1);
      }
    }
  }
  return x;
}

let fails = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!cond) fails++;
}

const cases = [
  { bpm: 100, offset: 0.37, seconds: 90, introSec: 16, outroSec: 16 },
  { bpm: 124, offset: 0.12, seconds: 120, introSec: 20, outroSec: 20 },
  { bpm: 128, offset: 0.5, seconds: 100 },
  { bpm: 92.5, offset: 0.2, seconds: 90 },
  { bpm: 140, offset: 0.05, seconds: 90, introSec: 10, outroSec: 10 },
];

for (const c of cases) {
  const t0 = Date.now();
  const r = A.analyzeSamples(makeTrack(c), SR);
  const ms = Date.now() - t0;
  const beat = 60 / c.bpm;
  check(`bpm ${c.bpm}`, Math.abs(r.bpm - c.bpm) <= 1, `got ${r.bpm} conf ${r.bpmConfidence} (${ms} ms)`);
  // phase error vs nearest true beat
  let ph = ((r.beatOffset - c.offset) % beat + beat) % beat;
  if (ph > beat / 2) ph -= beat;
  check(`  phase`, Math.abs(ph) < 0.03, `err ${(ph * 1000).toFixed(1)} ms`);
  // downbeat: beatOffset should land on a k%4==0 beat
  const kk = Math.round((r.beatOffset - c.offset) / beat);
  check(`  downbeat`, ((kk % 4) + 4) % 4 === 0, `beat index ${kk}`);
  check(`  beatSync`, r.beatSync, `punch ${r.punch}`);
  if (c.introSec) {
    check(`  intro/outro`, Math.abs(r.introEnd - c.introSec) <= 3 && Math.abs(r.outroStart - (c.seconds - c.outroSec)) <= 3,
      `intro ${r.introEnd} outro ${r.outroStart} (want ${c.introSec}/${c.seconds - c.outroSec})`);
  }
}

const ballad = A.analyzeSamples(makeTrack({ bpm: 80, offset: 0, seconds: 60, drums: false }), SR);
console.log('INFO  no-drums track (beatSync threshold is calibrated on real songs)', `conf ${ballad.bpmConfidence} punch ${ballad.punch} energy ${ballad.energyRaw}`);


/* ---------- structure: known sections ---------- */
function makeStructured(bpm, offset, plan, seed = 7) {
  const beat = 60 / bpm, bar = 4 * beat;
  const totalBars = plan.reduce((s, p) => s + p.bars, 0);
  const seconds = offset + totalBars * bar + 1;
  const x = new Float32Array(Math.floor(seconds * SR));
  const rand = rng(seed);
  let b0 = 0;
  for (const p of plan) {
    for (let b = b0; b < b0 + p.bars; b++) {
      for (let q = 0; q < 4; q++) {
        const bt = offset + (b * 4 + q) * beat, s0 = Math.floor(bt * SR);
        if (p.kick) for (let i = 0; i < 0.18 * SR && s0 + i < x.length; i++) { const t = i / SR; x[s0 + i] += 0.7 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t); }
        if (p.hats) { const h0 = Math.floor((bt + beat / 2) * SR); for (let i = 0; i < 0.03 * SR && h0 + i < x.length; i++) x[h0 + i] += 0.12 * Math.exp(-(i / SR) * 120) * (rand() * 2 - 1); }
      }
      const s0 = Math.floor((offset + b * bar) * SR), s1 = Math.floor((offset + (b + 1) * bar) * SR);
      for (let i = s0; i < s1 && i < x.length; i++) {
        const t = i / SR;
        x[i] += p.pad * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.18 * t) + Math.sin(2 * Math.PI * 329.63 * t)) / 3;
        if (p.bass) x[i] += 0.25 * Math.sin(2 * Math.PI * 55 * t);
        if (p.lead) x[i] += 0.06 * Math.sign(Math.sin(2 * Math.PI * 440 * t));
      }
    }
    b0 += p.bars;
  }
  return x;
}

const plan = [
  { bars: 16, kick: true, hats: true, pad: 0.02 },                         // intro
  { bars: 16, kick: true, hats: true, pad: 0.08, bass: true, lead: true }, // drop
  { bars: 8, pad: 0.07 },                                                  // breakdown
  { bars: 16, kick: true, hats: true, pad: 0.08, bass: true, lead: true }, // drop
  { bars: 16, kick: true, hats: true, pad: 0.02 },                         // outro
];
const sr = A.analyzeSamples(makeStructured(124, 0.3, plan), SR);
const secs = sr.sections || [];
console.log('\nsections:', secs.map(s => `${s.type}@${s.bar}(${s.bars}) lvl${s.lvl} b${s.bass}`).join('  '));
const want = [0, 16, 32, 40, 56];
const got = secs.map(s => s.bar);
check('structure: boundaries', want.every(w => got.some(g => Math.abs(g - w) <= 1)) && got.length <= 7, `got ${got.join(',')} want ${want.join(',')}`);
const typeAt = bar => (secs.find(s => bar >= s.bar && bar < s.bar + s.bars) || {}).type;
check('structure: labels', typeAt(8) === 'intro' && typeAt(24) === 'drop' && typeAt(36) === 'break' && typeAt(48) === 'drop' && typeAt(64) === 'outro',
  `intro:${typeAt(8)} drop:${typeAt(24)} break:${typeAt(36)} drop:${typeAt(48)} outro:${typeAt(64)}`);
// groove: four-on-the-floor kicks -> steps 0,4,8,12 clearly strongest (the quiet test hats sit under the bass)
const rh = sr.rhythm || [];
const avg = idx => idx.reduce((a, i) => a + rh[i], 0) / idx.length;
const onBeat = avg([0, 4, 8, 12]), offBeat = avg([2, 6, 10, 14]), others = avg([1, 3, 5, 7, 9, 11, 13, 15]);
check('groove pattern', onBeat > 3 * others && onBeat > 3 * offBeat, `on-beat ${onBeat.toFixed(2)} off-beat ${offBeat.toFixed(2)} others ${others.toFixed(2)}`);
check('style vector', Array.isArray(sr.style) && sr.style.length === 5, JSON.stringify(sr.style));

// grid quality: a steady electronic beat is safe to beat-match; a live, wandering tempo is not
function wander(bpm, secs, amount) {
  const x = new Float32Array(secs * SR); let t = 0.3, k = 0;
  while (t < secs - 0.3) {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < 0.15 * SR && s0 + i < x.length; i++) { const tt = i / SR; x[s0 + i] += 0.7 * Math.exp(-tt * 18) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-tt * 30)) * tt); }
    // amount = tempo change halfway through (live bands and some edits speed up)
    t += (60 / bpm) / (t > secs / 2 ? 1 + amount : 1); k++;
  }
  for (let i = 0; i < x.length; i++) x[i] += 0.05 * Math.sin(2 * Math.PI * 220 * i / SR);
  return x;
}
const steady = A.analyzeSamples(wander(120, 120, 0), SR), live = A.analyzeSamples(wander(120, 120, 0.05), SR);
check('steady grid holds', steady.beatSync && steady.gridDrift <= 30, `drift ${steady.gridDrift} ms fit ${steady.gridFit}`);
check('tempo change flagged', !live.beatSync, `120 -> 126 BPM halfway: drift ${live.gridDrift} ms misalign ${live.gridMisalign} fit ${live.gridFit}`);
// musical key: chord progressions with a kick (relative major/minor count as a match: same notes, same Camelot number)
{
  const hz = n => 440 * Math.pow(2, (n - 69) / 12), triad = (r, m) => [hz(r), hz(r + (m ? 3 : 4)), hz(r + 7)];
  const song = chords => { const secs = 60, beat = 0.5, x = new Float32Array(secs * SR);
    for (let i = 0; i < x.length; i++) { const t = i / SR, ch = chords[Math.floor(t / (4 * beat)) % chords.length]; let v = 0; for (const f of ch) v += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t); x[i] = 0.06 * v / ch.length; }
    for (let t = 0.2; t < secs - 0.2; t += beat) { const s0 = Math.floor(t * SR); for (let i = 0; i < 0.15 * SR; i++) { const tt = i / SR; x[s0 + i] += 0.6 * Math.exp(-tt * 18) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-tt * 30)) * tt); } }
    return x; };
  const same = { 'A minor': ['A minor', 'C major'], 'D major': ['D major', 'B minor'], 'E minor': ['E minor', 'G major'] };
  for (const [want, ch] of [['A minor', [triad(57, 1), triad(53), triad(48), triad(55)]], ['D major', [triad(50), triad(57), triad(59, 1), triad(55)]], ['E minor', [triad(52, 1), triad(48), triad(55), triad(50)]]]) {
    const r = A.analyzeSamples(song(ch), SR);
    check('key ' + want, same[want].includes(r.keyDetected), `detected ${r.keyDetected} (strength ${r.keyStrength})`);
  }
}
console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
