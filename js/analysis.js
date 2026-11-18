/* Audio analysis: tempo, beat grid, energy, intro/outro.
   Pure functions on Float32Array so it runs in the browser and in Node tests. */
(function (root) {
  'use strict';

  const HOP = 256;

  function toMono(channels) {
    if (channels.length === 1) return channels[0];
    const n = channels[0].length;
    const out = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i];
    const k = 1 / channels.length;
    for (let i = 0; i < n; i++) out[i] *= k;
    return out;
  }

  function lowpass(x, sr, fc) {
    const a = Math.exp((-2 * Math.PI * fc) / sr);
    const b = 1 - a;
    const y = new Float32Array(x.length);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
      s1 = b * x[i] + a * s1;
      s2 = b * s1 + a * s2;
      y[i] = s2;
    }
    return y;
  }

  function movingAverage(arr, half) {
    const n = arr.length, out = new Float32Array(n);
    let sum = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
      while (hi < b) sum += arr[++hi];
      while (lo < a) sum -= arr[lo++];
      out[i] = sum / (hi - lo + 1);
    }
    return out;
  }

  function percentile(arr, p) {
    const s = Array.from(arr).sort((a, b) => a - b);
    if (!s.length) return 0;
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  }

  // Frame energies and onset envelope
  function onsetEnvelope(x, sr) {
    const nF = Math.floor(x.length / HOP);
    const low = lowpass(x, sr, 150);
    const eAll = new Float32Array(nF), eLow = new Float32Array(nF);
    for (let f = 0; f < nF; f++) {
      let sa = 0, sl = 0;
      const o = f * HOP;
      for (let i = 0; i < HOP; i++) {
        const v = x[o + i], l = low[o + i];
        sa += v * v; sl += l * l;
      }
      eAll[f] = Math.sqrt(sa / HOP);
      eLow[f] = Math.sqrt(sl / HOP);
    }
    const onsetLow = new Float32Array(nF), onsetAll = new Float32Array(nF);
    let pa = Math.log1p(1000 * eAll[0]), pl = Math.log1p(1000 * eLow[0]);
    for (let f = 1; f < nF; f++) {
      const ca = Math.log1p(1000 * eAll[f]), cl = Math.log1p(1000 * eLow[f]);
      onsetAll[f] = Math.max(0, ca - pa);
      onsetLow[f] = Math.max(0, cl - pl);
      pa = ca; pl = cl;
    }
    const comb = new Float32Array(nF);
    for (let f = 0; f < nF; f++) comb[f] = onsetLow[f] + 0.5 * onsetAll[f];
    // whiten: remove local mean (~0.4 s)
    const fps = sr / HOP;
    const m = movingAverage(comb, Math.round(fps * 0.2));
    for (let f = 0; f < nF; f++) comb[f] = Math.max(0, comb[f] - m[f]);
    return { eAll, eLow, onsetLow, onset: comb, fps };
  }

  function interp(a, t) {
    const i = Math.floor(t), fr = t - i;
    if (i < 0 || i + 1 >= a.length) return 0;
    return a[i] * (1 - fr) + a[i + 1] * fr;
  }

  function autocorr(o, lag) {
    const L0 = Math.floor(lag), fr = lag - L0;
    const n = o.length - L0 - 1;
    if (n <= 0) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) s += o[i] * (o[i + L0] * (1 - fr) + o[i + L0 + 1] * fr);
    return s / n;
  }

  function tempoPrior(bpm) {
    const oct = Math.log2(bpm / 120);
    return Math.exp(-0.5 * (oct / 0.55) * (oct / 0.55));
  }

  function estimateTempo(onset, fps) {
    const N = onset.length;
    const maxLen = Math.floor(fps * 120);
    let start = 0, end = N;
    if (N > maxLen) { start = Math.floor((N - maxLen) / 2); end = start + maxLen; }
    const seg = onset.slice(start, end);
    let mean = 0;
    for (let i = 0; i < seg.length; i++) mean += seg[i];
    mean /= seg.length || 1;
    for (let i = 0; i < seg.length; i++) seg[i] -= mean;

    const score = (bpm, mults) => {
      const lag = (60 * fps) / bpm;
      let s = 0, w = 1;
      for (const m of mults) { s += w * autocorr(seg, lag * m); w *= 0.7; }
      return s;
    };

    let best = 0, bestS = -Infinity, sum = 0, cnt = 0;
    for (let bpm = 70; bpm <= 180; bpm += 0.25) {
      const raw = score(bpm, [1, 2, 4]);
      const s = raw * (0.4 + tempoPrior(bpm));
      sum += Math.max(0, raw); cnt++;
      if (s > bestS) { bestS = s; best = bpm; }
    }
    // refine with long lags for precision
    let fine = best, fineS = -Infinity;
    for (let bpm = best - 0.6; bpm <= best + 0.6; bpm += 0.02) {
      const s = score(bpm, [1, 2, 4, 8, 16]);
      if (s > fineS) { fineS = s; fine = bpm; }
    }
    const peakRaw = score(best, [1, 2, 4]);
    const confidence = sum > 0 ? peakRaw / (sum / cnt) : 0;
    return { bpm: Math.round(fine * 100) / 100, confidence };
  }

  function beatPhase(onset, periodFrames) {
    let bestPhi = 0, bestS = -Infinity;
    for (let phi = 0; phi < periodFrames; phi += 0.25) {
      let s = 0;
      for (let t = phi; t < onset.length - 1; t += periodFrames) s += interp(onset, t);
      if (s > bestS) { bestS = s; bestPhi = phi; }
    }
    return bestPhi;
  }

  /* ---------- song structure ----------
     Per-bar fingerprint -> novelty (where the sound changes) -> boundaries on a 4-bar phrase grid
     -> sections labelled high (drop/chorus) or low (intro/break/outro). */
  function structure(x, sr, env, beatOffset, beatLen, duration, firstSound, lastSound) {
    const barLen = 4 * beatLen;
    const nBars = Math.floor((duration - beatOffset) / barLen);
    if (nBars < 16) return null;
    // frequency bands from cascaded low-passes
    const l1 = lowpass(x, sr, 150), l2 = lowpass(x, sr, 600), l3 = lowpass(x, sr, 2500);
    const F = 7;
    const feat = [];
    const fps = env.fps;
    for (let b = 0; b < nBars; b++) {
      const s0 = Math.floor((beatOffset + b * barLen) * sr), s1 = Math.min(x.length, Math.floor((beatOffset + (b + 1) * barLen) * sr));
      let e0 = 0, e1 = 0, e2 = 0, e3 = 0, ea = 0;
      for (let i = s0; i < s1; i += 2) {
        const a0 = l1[i], a1 = l2[i] - l1[i], a2 = l3[i] - l2[i], a3 = x[i] - l3[i];
        e0 += a0 * a0; e1 += a1 * a1; e2 += a2 * a2; e3 += a3 * a3; ea += x[i] * x[i];
      }
      const n = Math.max(1, (s1 - s0) / 2);
      const f0 = Math.floor(s0 / HOP), f1 = Math.min(env.onset.length, Math.floor(s1 / HOP));
      let oL = 0, oA = 0;
      for (let f = f0; f < f1; f++) { oL += env.onsetLow[f]; oA += env.onset[f]; }
      const nf = Math.max(1, f1 - f0);
      const db = v => 10 * Math.log10(v / n + 1e-10);
      feat.push([db(e0), db(e1), db(e2), db(e3), oL / nf * 40, oA / nf * 40, db(ea)]);
    }
    // z-score each dimension
    const z = feat.map(r => r.slice());
    for (let d = 0; d < F; d++) {
      let m = 0, v = 0;
      for (const r of feat) m += r[d];
      m /= nBars;
      for (const r of feat) v += (r[d] - m) * (r[d] - m);
      const sd = Math.sqrt(v / nBars) || 1;
      for (const r of z) r[d] = Math.max(-3, Math.min(3, (r[d] - m) / sd));
    }
    const W = [1, 0.8, 0.8, 0.6, 1.4, 0.8, 1.4];
    const dist = (i, j) => { let s = 0; for (let d = 0; d < F; d++) { const q = (z[i][d] - z[j][d]) * W[d]; s += q * q; } return Math.sqrt(s); };
    // checkerboard novelty, half-width 8 bars, gaussian taper
    const L = 8, nov = new Float32Array(nBars + 1);
    const g = k => Math.exp(-0.5 * (k / (L / 2)) * (k / (L / 2)));
    for (let b = 2; b < nBars - 1; b++) {
      let cross = 0, cw = 0, within = 0, ww = 0;
      for (let i = 1; i <= L; i++) for (let j = 1; j <= L; j++) {
        const A = b - i, B = b - 1 + j;
        if (A < 0 || B >= nBars) continue;
        const w = g(i - 0.5) * g(j - 0.5);
        cross += w * dist(A, B); cw += w;
        const A2 = b - j;
        if (A2 >= 0) { within += w * 0.5 * dist(A, A2); ww += w * 0.5; }
        const B2 = b - 1 + i;
        if (B2 < nBars) { within += w * 0.5 * dist(B, B2); ww += w * 0.5; }
      }
      nov[b] = Math.max(0, (cw ? cross / cw : 0) - (ww ? within / ww : 0));
    }
    // phrase grid offset (mod 4) with the most novelty
    let off = 0, bestO = -1;
    for (let o = 0; o < 4; o++) { let s = 0; for (let b = o; b <= nBars; b += 4) s += nov[b]; if (s > bestO) { bestO = s; off = o; } }
    // the strongest change within +-1 bar counts for that grid point (DJ phrases are rarely off by more)
    const gridNov = [];
    for (let b = off; b <= nBars; b += 4) gridNov.push([b, Math.max(nov[b], 0.8 * (nov[b - 1] || 0), 0.8 * (nov[b + 1] || 0))]);
    const vals = gridNov.map(v => v[1]).sort((a, b) => a - b);
    const maxN = vals[vals.length - 1] || 0;
    // relative to the song's typical change, so huge intro/outro jumps don't hide verse/chorus changes
    const thr = Math.max(0.15 * maxN, 1.6 * (vals[Math.floor(vals.length * 0.5)] || 0));
    // second detector: 4-bar loudness steps (breakdowns, drops) on the same grid
    const barDb = feat.map(r => r[6]);
    const blockMean = (b0, b1) => { let s = 0, n = 0; for (let k = Math.max(0, b0); k < Math.min(nBars, b1); k++) { s += barDb[k]; n++; } return n ? s / n : null; };
    const stepAt = b => { const l = blockMean(b - 4, b), r = blockMean(b, b + 4); return l == null || r == null ? 0 : Math.abs(r - l); };
    const firstBar = Math.max(0, Math.floor((firstSound - beatOffset) / barLen));
    const lastBar = Math.min(nBars, Math.ceil((lastSound - beatOffset) / barLen));
    let bounds = [firstBar];
    for (let k = 0; k < gridNov.length; k++) {
      const [b, v] = gridNov[k];
      if (b <= firstBar + 2 || b >= lastBar - 2) continue;
      const prev = k > 0 ? gridNov[k - 1][1] : 0, next = k < gridNov.length - 1 ? gridNov[k + 1][1] : 0;
      if ((v >= thr && v >= prev && v >= next) || stepAt(b) >= 2.5) bounds.push(b);
    }
    bounds.push(lastBar);
    bounds = bounds.filter((b, i, a) => i === 0 || b - a[i - 1] >= 4);
    if (bounds[bounds.length - 1] !== lastBar) bounds[bounds.length - 1] = lastBar;
    // label sections
    const barLoud = feat.map(r => r[6]), barBass = feat.map(r => r[0]);
    const loudRef = percentile(barLoud.slice(firstBar, lastBar), 0.75);
    const bassRef = percentile(barBass.slice(firstBar, lastBar), 0.75);
    const secs = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i], b = bounds[i + 1];
      let lsum = 0, bsum = 0;
      for (let k = a; k < b; k++) { lsum += barLoud[k]; bsum += barBass[k]; }
      const lvl = lsum / (b - a) - loudRef, bass = bsum / (b - a) - bassRef;
      // high-energy section (drop/chorus): near the song's loudest level with full bass
      secs.push({ bar: a, bars: b - a, lvl: Math.round(lvl * 10) / 10, bass: Math.round(bass * 10) / 10, h: lvl >= -2.5 && bass >= -4 });
    }
    const firstH = secs.findIndex(s => s.h);
    let lastH = -1;
    secs.forEach((s, i) => { if (s.h) lastH = i; });
    secs.forEach((s, i) => {
      s.type = s.h ? 'drop' : (firstH < 0 || i < firstH ? 'intro' : i > lastH ? 'outro' : 'break');
      s.t0 = Math.round((beatOffset + s.bar * barLen) * 100) / 100;
      s.t1 = Math.round((beatOffset + (s.bar + s.bars) * barLen) * 100) / 100;
    });
    // groove + style fingerprints from the high-energy bars (drops/choruses), falling back to all bars
    let hb = [];
    secs.forEach(s => { if (s.h) for (let k = s.bar; k < s.bar + s.bars; k++) hb.push(k); });
    if (hb.length < 4) hb = Array.from({ length: lastBar - firstBar }, (_, i) => firstBar + i);
    // 16-step drum pattern: onset strength on each 16th note of the bar, averaged and unit-normalised
    const rhythm = new Array(16).fill(0);
    for (const k of hb) for (let st = 0; st < 16; st++) {
      const fr = ((beatOffset + (k * 4 + st / 4) * beatLen) * sr) / HOP;
      let m = 0;
      for (let f = Math.floor(fr) - 1; f <= Math.ceil(fr) + 1; f++) if (f >= 0 && f < env.onset.length) m = Math.max(m, env.onset[f] + env.onsetLow[f]);
      rhythm[st] += m;
    }
    const rn = Math.sqrt(rhythm.reduce((a, v) => a + v * v, 0)) || 1;
    // style: spectral balance (each band relative to full level, dB) and drum density
    const style = [0, 0, 0, 0, 0];
    for (const k of hb) { for (let d = 0; d < 4; d++) style[d] += feat[k][d] - feat[k][6]; style[4] += feat[k][5]; }
    const out = {
      secs,
      rhythm: rhythm.map(v => Math.round((v / rn) * 1000) / 1000),
      style: style.map(v => Math.round((v / hb.length) * 10) / 10),
    };
    secs.debug = { off, thr: Math.round(thr * 100) / 100 };
    return out;
  }

  /* ---------- musical key (for harmonic mixing) ----------
     Chroma (energy per pitch class, 55 Hz - 2 kHz) from FFT frames across the body of the song,
     matched against the Krumhansl-Kessler major/minor key profiles. Returns e.g. { name: 'A minor', strength }. */
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  function fftMag(frame) {
    const N = frame.length, re = new Float64Array(N), im = new Float64Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); re[r] = frame[i]; }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, ang = -2 * Math.PI / size;
      for (let st = 0; st < N; st += size) for (let k = 0; k < half; k++) {
        const c = Math.cos(ang * k), sn = Math.sin(ang * k), a = st + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    const mag = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }
  function detectKey(x, sr, t0, t1) {
    const N = 8192, hann = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    const chroma = new Float64Array(12);
    const pc = new Int8Array(N / 2).fill(-1);
    for (let k = 1; k < N / 2; k++) {
      const f = k * sr / N;
      if (f < 55 || f > 2000) continue;
      pc[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
    }
    const a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(x.length - N, Math.floor(t1 * sr));
    const step = Math.max(N, Math.floor((b - a) / 90)); // ~90 frames across the song
    const frame = new Float64Array(N);
    let frames = 0;
    for (let o = a; o < b; o += step) {
      for (let i = 0; i < N; i++) frame[i] = x[o + i] * hann[i];
      const mag = fftMag(frame);
      const c = new Float64Array(12);
      for (let k = 1; k < N / 2; k++) if (pc[k] >= 0) c[pc[k]] += mag[k];
      const m = Math.max(...c) || 1;
      for (let i = 0; i < 12; i++) chroma[i] += c[i] / m;   // each frame counts equally
      frames++;
    }
    if (frames < 4) return null;
    const corr = (prof, root) => {
      let mx = 0, my = 0;
      for (let i = 0; i < 12; i++) { mx += chroma[(i + root) % 12]; my += prof[i]; }
      mx /= 12; my /= 12;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < 12; i++) { const dx = chroma[(i + root) % 12] - mx, dy = prof[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
      return sxy / Math.sqrt(sxx * syy || 1);
    };
    let best = null, second = -2;
    for (let r = 0; r < 12; r++) for (const [prof, mode] of [[KK_MAJ, 'major'], [KK_MIN, 'minor']]) {
      const c = corr(prof, r);
      if (!best || c > best.c) { if (best) second = Math.max(second, best.c); best = { c, name: NOTES[r] + ' ' + mode }; }
      else second = Math.max(second, c);
    }
    return { name: best.name, strength: Math.round(best.c * 100) / 100, margin: Math.round((best.c - second) * 100) / 100 };
  }

  function analyzeSamples(channels, sr, hintBpm) {
    const x = Array.isArray(channels) ? toMono(channels) : channels;
    const duration = x.length / sr;
    const env = onsetEnvelope(x, sr);
    const fps = env.fps;

    // loudness per second
    const secs = Math.max(1, Math.floor(duration));
    const loud = new Float32Array(secs);
    for (let s = 0; s < secs; s++) {
      const a = Math.floor(s * sr), b = Math.min(x.length, Math.floor((s + 1) * sr));
      let sum = 0;
      for (let i = a; i < b; i++) sum += x[i] * x[i];
      loud[s] = 10 * Math.log10(sum / Math.max(1, b - a) + 1e-12);
    }
    const audible = Array.from(loud).filter(v => v > -60);
    const body = audible.length ? percentile(audible, 0.75) : -60;
    const smooth = movingAverage(loud, 2);
    let introEnd = 0, outroStart = secs;
    for (let s = 0; s < secs; s++) if (smooth[s] >= body - 4) { introEnd = s; break; }
    for (let s = secs - 1; s >= 0; s--) if (smooth[s] >= body - 4) { outroStart = s + 1; break; }

    // first/last sound at frame precision (-50 dBFS)
    const thr = Math.pow(10, -50 / 20);
    let firstSound = 0, lastSound = duration;
    for (let f = 0; f < env.eAll.length; f++) if (env.eAll[f] > thr) { firstSound = (f * HOP) / sr; break; }
    for (let f = env.eAll.length - 1; f >= 0; f--) if (env.eAll[f] > thr) { lastSound = ((f + 1) * HOP) / sr; break; }

    // tempo + beat grid
    const tempo = estimateTempo(env.onset, fps);
    const f0 = Math.floor(firstSound * fps), f1 = Math.min(env.onset.length - 2, Math.floor(lastSound * fps));
    let allSum = 0, allN = 0;
    for (let f = f0; f < f1; f++) { allSum += env.onset[f]; allN++; }

    // Build a beat grid around a tempo guess, then measure how well it holds.
    //  drift = how far (ms) the beats in each sixth of the song sit from the one global grid.
    //          Live-played songs (many Bollywood/Punjabi originals) speed up and slow down, and a wrong
    //          tempo guess also shows up here, so beat-matching such a grid would audibly slip.
    //  fit   = onset strength on grid beats vs. the song's average onset (how clearly the beat is marked)
    function gridAt(bpm0) {
      let period = (60 * fps) / bpm0, phi = 0, bestComb = -Infinity;
      for (let bpm = bpm0 - 0.3; bpm <= bpm0 + 0.3; bpm += 0.01) { // joint fine search of tempo + phase
        const P = (60 * fps) / bpm;
        const ph = beatPhase(env.onset, P);
        let sum = 0;
        for (let t = ph; t < env.onset.length - 1; t += P) sum += interp(env.onset, t);
        if (sum > bestComb) { bestComb = sum; period = P; phi = ph; }
      }
      phi += 0.5; // onset frame starts before the actual attack on average
      // downbeat: which of 4 beat classes has the strongest bass onsets
      const cls = [0, 0, 0, 0];
      let k = 0;
      for (let t = phi; t < env.onsetLow.length - 1; t += period, k++) { let m = 0; for (let f = Math.floor(t) - 1; f <= Math.ceil(t) + 1; f++) if (f >= 0 && f < env.onset.length) m = Math.max(m, env.onsetLow[f] + env.onset[f]); cls[k % 4] += m; }
      const down = cls.indexOf(Math.max(...cls));
      const grid0 = phi + down * period;
      // Check the grid in short 8-beat windows across the song. In each, look for the strongest beat
      // position within +-0.15 beat of the grid (off-beat snares/hats at 0.5 and 16th-note dhol/hat accents at
      // 0.25 are outside that, so syncopated grooves don't read as drift).
      //  drift    = how far (ms) those positions stray from the grid (85th percentile, so a couple of odd windows don't count)
      //  misalign = share of drum-heavy windows where the grid itself is clearly weaker than a nearby position
      // A steady, correctly-tempo'd song scores ~0 on both; a tempo change or a wrong tempo guess does not.
      const W = 8, win = [];
      const kStart = Math.ceil((f0 - grid0) / period), kEnd = Math.floor((f1 - grid0) / period) - W;
      const lim = 0.15 * period;
      // onset spikes are ~1 frame wide, so read the strongest value within +-1 frame (~12 ms)
      const peak = t => { let m = 0; for (let f = Math.floor(t) - 1; f <= Math.ceil(t) + 1; f++) if (f >= 0 && f < env.onset.length && env.onset[f] > m) m = env.onset[f]; return m; };
      for (let k0 = kStart; k0 <= kEnd; k0 += W) {
        let best = 0, bestS = -1, on = 0;
        for (let sh = -lim; sh <= lim; sh += 1) {
          let sum = 0;
          for (let kk = k0; kk < k0 + W; kk++) sum += peak(grid0 + kk * period + sh);
          if (sum > bestS) { bestS = sum; best = sh; }
        }
        for (let kk = k0; kk < k0 + W; kk++) on += peak(grid0 + kk * period);
        win.push({ k: k0 + W / 2, sh: best, strength: bestS / W, on: on / W });
      }
      // skip drum-less windows (intros, breakdowns): their "best position" is noise
      const strengths = win.map(x => x.strength).sort((p, q) => p - q);
      const medS = strengths[Math.floor(strengths.length / 2)] || 0;
      const used = win.filter(x => x.strength >= 0.6 * medS);
      const offs = used.map(x => Math.abs(x.sh)).sort((p, q) => p - q);
      const frameMs = (HOP * 1000) / sr;
      const drift = offs.length >= 4 ? Math.round(offs[Math.floor(offs.length * 0.85)] * frameMs) : 999;
      const misalign = used.length ? Math.round((used.filter(x => x.on < 0.6 * x.strength).length / used.length) * 100) / 100 : 1;
      let onSum = 0;
      for (const x of used) onSum += x.on;
      const fit = allN && used.length ? Math.round(((onSum / used.length) / (allSum / allN || 1e-9)) * 100) / 100 : 0;
      // saturated: the beats sit at the edge of the search window, so the real wander may be larger than we can follow
      const sat = used.length ? used.filter(x => Math.abs(x.sh) >= lim - 1).length / used.length : 1;
      return { bpm: Math.round(((60 * fps) / period) * 100) / 100, period, phi, down, drift, fit, misalign, sat, wins: used.map(x => [x.k, x.sh]) };
    }

    let grid = gridAt(tempo.bpm);
    tempo.source = 'audio';
    // second opinion: if our grid doesn't hold and the uploader's tag disagrees, try the tag's tempo
    // (a 1% tempo error already slips ~2 beats over 3 minutes, so close tags and small nudges count too)
    // A drifting grid is still usable if the drift is slow enough to follow with a correction map (see gridCorr)
    const followable = g => g.sat <= 0.1;
    const bad = g => g.misalign > 0.25 || g.fit < 1.8 || (g.drift > 45 && !followable(g));
    if (bad(grid)) {
      const base = grid.bpm;
      const cands = [];
      if (hintBpm) for (const b of [hintBpm, hintBpm * 2, hintBpm / 2]) cands.push([b, 'tag']);
      for (const f of [0.99, 1.01, 0.995, 1.005]) cands.push([base * f, 'nudge']);
      for (const [b, src] of cands) {
        if (b < 70 || b > 160 || Math.abs(b / grid.bpm - 1) < 0.003) continue; // no double-time guesses
        const g = gridAt(b);
        const better = (bad(grid) && !bad(g)) || (g.drift + 10 < grid.drift && g.misalign <= grid.misalign && g.fit >= grid.fit * 0.9);
        if (better) { grid = g; tempo.source = src; }
      }
    }
    tempo.bpm = grid.bpm;
    const { period, phi, down } = grid;
    const gridDrift = grid.drift, gridFit = grid.fit, gridMisalign = grid.misalign;
    const beatLen = 60 / tempo.bpm;
    let beatOffset = ((phi + down * period) * HOP) / sr;
    while (beatOffset - 4 * beatLen >= 0) beatOffset -= 4 * beatLen; // earliest downbeat

    // Grid correction map for songs whose beats slowly wander (live-played originals): where the beats
    // really are, per 8-beat window, as [beat index, offset in seconds]. Smoothed over 3 windows.
    // The mixer adds this to the straight grid, so cue points and the phase lock follow the real beats.
    let gridCorr = null;
    if (grid.drift > 25 && grid.wins.length >= 4) {
      const kbase = Math.round(((phi + down * period) * HOP / sr - beatOffset) / beatLen);
      const raw = grid.wins.map(([k, sh]) => [k + kbase, (sh * HOP) / sr]);
      gridCorr = raw.map((w, i) => {
        const nb = [raw[i - 1], w, raw[i + 1]].filter(Boolean).map(x => x[1]).sort((p, q) => p - q);
        return [Math.round(w[0] * 10) / 10, Math.round(nb[Math.floor(nb.length / 2)] * 10000) / 10000];
      });
    }

    // energy features over the body of the song
    const a = Math.floor(introEnd * fps), b = Math.max(a + 1, Math.floor(outroStart * fps));
    let punch = 0, lowE = 0, allE = 0;
    for (let f = a; f < b && f < env.onset.length; f++) {
      punch += env.onsetLow[f];
      lowE += env.eLow[f] * env.eLow[f];
      allE += env.eAll[f] * env.eAll[f];
    }
    punch /= Math.max(1, b - a);
    const bassRatio = allE > 0 ? lowE / allE : 0;
    const loudN = Math.min(1, Math.max(0, (body + 30) / 22));
    const punchN = punch / (punch + 0.04);
    const tempoN = Math.min(1, Math.max(0, (Math.min(tempo.bpm, 150) - 70) / 60));
    const energyRaw = 0.4 * loudN + 0.3 * punchN + 0.15 * tempoN + 0.15 * Math.min(1, bassRatio * 2);

    // musical key over the body of the song (skip intro/outro)
    let key = null;
    try { key = detectKey(x, sr, Math.max(firstSound, introEnd), Math.min(lastSound, outroStart)); } catch (e) { key = null; }

    // a grid we can trust: clear tempo, real drums, and it holds through the song
    const beatSync = tempo.confidence > 1.6 && punch > 0.012 && !bad(grid);
    const st = tempo.confidence > 1.6 && punch > 0.012
      ? structure(x, sr, env, beatOffset, beatLen, duration, firstSound, lastSound)
      : null;
    const sections = st ? st.secs : null;

    // waveform peaks
    const P = 400, peaks = new Array(P);
    const step = x.length / P;
    for (let p = 0; p < P; p++) {
      let m = 0;
      const s0 = Math.floor(p * step), s1 = Math.floor((p + 1) * step);
      for (let i = s0; i < s1; i += 4) { const v = Math.abs(x[i]); if (v > m) m = v; }
      peaks[p] = Math.round(Math.min(1, m) * 255);
    }

    return {
      v: 8,
      duration,
      sections,
      rhythm: st ? st.rhythm : null,
      style: st ? st.style : null,
      bpm: tempo.bpm,
      bpmConfidence: Math.round(tempo.confidence * 100) / 100,
      gridDrift, gridFit, gridMisalign, gridCorr,
      keyDetected: key && key.strength > 0.5 ? key.name : null, keyStrength: key ? key.strength : 0,
      beatSync,
      tempoSource: tempo.source,
      beatOffset,
      firstSound, lastSound,
      introEnd, outroStart,
      bodyDb: Math.round(body * 10) / 10,
      punch: Math.round(punch * 10000) / 10000,
      bassRatio: Math.round(bassRatio * 1000) / 1000,
      energyRaw: Math.round(energyRaw * 1000) / 1000,
      loud: Array.from(loud, v => Math.round(v)),
      peaks,
    };
  }

  // Browser helper: decode + analyze. Resamples to 22.05 kHz to save memory/time.
  async function analyzeArrayBuffer(buf, hintBpm) {
    const Ctx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, 22050);
    const audio = await ctx.decodeAudioData(buf);
    const ch = [];
    for (let c = 0; c < audio.numberOfChannels; c++) ch.push(audio.getChannelData(c));
    return analyzeSamples(ch, audio.sampleRate, hintBpm);
  }

  const api = { analyzeSamples, analyzeArrayBuffer, HOP };
  root.DJAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
