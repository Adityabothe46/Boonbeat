/* In-browser AI scores with Essentia's MusiCNN models (MTG, Universitat Pompeu Fabra; CC BY-NC-SA, personal use).
   Per song: danceability, party mood, and a vocal probability for every ~3 s patch.
   Libraries load lazily on first use; if anything fails, DJML.ready becomes false and the app carries on without it. */
(function (root) {
  'use strict';

  const LIBS = [
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js',
    'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.umd.js',
    'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-model.umd.js',
  ];
  const SR = 16000, FRAME = 512, HOP = 256, PATCH = 187;
  const PATCH_SEC = (PATCH * HOP) / SR; // ~2.99 s

  let initP = null, extractor = null, base = null, heads = {};
  const state = { ready: null, error: null };

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = false; s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = () => rej(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function init() {
    if (initP) return initP;
    initP = (async () => {
      const have = [() => !!root.tf, () => !!(root.Module && root.Module.EssentiaJS) || !!root.EssentiaWASM, () => !!root.EssentiaModel];
      for (let i = 0; i < LIBS.length; i++) {
        if (have[i]()) continue;
        // the WASM bundle ends with `exports.EssentiaWASM = Module`; give it a temporary object so it doesn't throw
        const tmp = i === 1 && !('exports' in root);
        if (tmp) root.exports = {};
        await loadScript(LIBS[i]);
        if (tmp) delete root.exports;
      }
      // the UMD build is a plain Emscripten script: it leaves the module in the global `Module`
      // (and throws on its last line, `exports.EssentiaWASM = Module`, which is harmless in a browser)
      const W = (root.EssentiaWASM && root.EssentiaWASM.EssentiaWASM) || root.EssentiaWASM || root.Module;
      for (let i = 0; i < 200 && !(W && W.calledRun && W.EssentiaJS); i++) await sleep(50);
      if (!W || !W.EssentiaJS) throw new Error('essentia wasm did not start');
      extractor = new root.EssentiaModel.EssentiaTFInputExtractor(W, 'musicnn');
      const tf = root.tf;
      try { await tf.setBackend('webgl'); } catch (e) { /* cpu fallback */ }
      await tf.ready();
      base = await tf.loadGraphModel('models/msd-musicnn/model.json');
      for (const h of ['danceability', 'voice_instrumental', 'mood_party']) heads[h] = await tf.loadGraphModel(`models/${h}/model.json`);
      state.ready = true;
    })().catch(e => { state.ready = false; state.error = e.message; console.warn('[ml] disabled:', e.message); throw e; });
    return initP;
  }

  async function decode16k(blob) {
    const buf = await blob.arrayBuffer();
    const ctx = new (root.OfflineAudioContext || root.webkitOfflineAudioContext)(1, 1, SR);
    const audio = await ctx.decodeAudioData(buf);
    const n = audio.length, out = new Float32Array(n);
    for (let c = 0; c < audio.numberOfChannels; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / audio.numberOfChannels; }
    return out;
  }

  /* Fast JS port of Essentia's TensorflowInputMusiCNN (checked against Essentia's own output, see selfTest):
     hann window (not normalised) -> |FFT 512| -> power -> 96 Slaney-mel triangles, unit area, 0-8 kHz
     -> log10(1 + 10000 x). Essentia's WASM version takes ~1.7 ms per frame; this takes ~0.03 ms. */
  const N = FRAME, NB = N / 2 + 1, BANDS = 96;
  const hann = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const hzToMel = f => (f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27));
  const melToHz = m => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((m - 15) * (Math.log(6.4) / 27)));
  let filt = null;
  function makeFilters(norm) {
    const lo = hzToMel(0), hi = hzToMel(8000);
    const pts = [];
    for (let i = 0; i < BANDS + 2; i++) pts.push(melToHz(lo + ((hi - lo) * i) / (BANDS + 1)));
    const bins = [];
    for (let b = 0; b < BANDS; b++) {
      const f0 = pts[b], f1 = pts[b + 1], f2 = pts[b + 2], w = [];
      for (let j = 0; j < NB; j++) {
        const f = (j * SR) / N;
        let v = 0;
        if (f > f0 && f < f2) v = f <= f1 ? (f - f0) / (f1 - f0) : (f2 - f) / (f2 - f1);
        if (v > 0) w.push([j, v]);
      }
      let scale = 1;
      if (norm === 'unit_tri') scale = 2 / (f2 - f0);
      else if (norm === 'unit_sum') { const s = w.reduce((a, [, v]) => a + v, 0); scale = s ? 1 / s : 1; }
      bins.push(w.map(([j, v]) => [j, v * scale]));
    }
    return bins;
  }
  // radix-2 FFT (in place, re/im arrays)
  const rev = new Uint16Array(N);
  for (let i = 0, bits = Math.log2(N); i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = -Math.sin((2 * Math.PI * i) / N); }
  const re = new Float32Array(N), im = new Float32Array(N), pow = new Float32Array(NB);
  function melOfFrame(x, off, out, outOff, cfg) {
    for (let i = 0; i < N; i++) { re[rev[i]] = x[off + i] * hann[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let s = 0; s < N; s += size) for (let k = 0; k < half; k++) {
        const c = cosT[k * step], sn = sinT[k * step], a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    for (let j = 0; j < NB; j++) { const m2 = re[j] * re[j] + im[j] * im[j]; pow[j] = cfg.power ? m2 : Math.sqrt(m2); }
    for (let b = 0; b < BANDS; b++) {
      let s = 0;
      for (const [j, w] of cfg.filt[b]) s += pow[j] * w;
      out[outOff + b] = Math.log10(1 + 10000 * s);
    }
  }
  const CFG = { power: true, norm: 'unit_tri' };

  async function melFrames(x) {
    if (!filt) filt = makeFilters(CFG.norm);
    const cfg = { power: CFG.power, filt };
    const nF = Math.floor((x.length - FRAME) / HOP) + 1;
    const mel = new Float32Array(nF * BANDS);
    for (let f = 0; f < nF; f++) {
      melOfFrame(x, f * HOP, mel, f * BANDS, cfg);
      if (f % 800 === 799) await sleep(0);   // small slices, so the page never freezes
    }
    return { mel, nF };
  }

  // compare our mel against Essentia's on random noise frames; picks the matching variant
  async function selfTest() {
    await init();
    const fr = new Float32Array(N);
    let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
    const frames = [];
    for (let k = 0; k < 6; k++) { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = rnd() * (0.05 + k * 0.15) + 0.3 * Math.sin(i * (0.05 + k * 0.2)); frames.push(a); }
    const refs = frames.map(a => Float32Array.from(extractor.compute(a).melSpectrum));
    const results = [];
    for (const power of [true, false]) for (const norm of ['unit_tri', 'unit_sum', 'none']) {
      const cfg = { power, filt: makeFilters(norm) };
      let err = 0, n = 0;
      const out = new Float32Array(BANDS);
      frames.forEach((a, k) => { melOfFrame(a, 0, out, 0, cfg); for (let b = 0; b < BANDS; b++) { err += Math.abs(out[b] - refs[k][b]); n++; } });
      results.push({ power, norm, meanAbsErr: err / n });
    }
    results.sort((a, b) => a.meanAbsErr - b.meanAbsErr);
    CFG.power = results[0].power; CFG.norm = results[0].norm; filt = null;
    return results;
  }

  async function analyzeBlob(blob) {
    await init();
    const tf = root.tf;
    const x = await decode16k(blob);
    const { mel, nF } = await melFrames(x);
    const nP = Math.floor(nF / PATCH);
    if (nP < 2) return null;
    const dance = [], party = [], voice = [];
    const BATCH = 4;   // short GPU bursts: long ones stall the mixer on phones
    for (let p0 = 0; p0 < nP; p0 += BATCH) {
      const nb = Math.min(BATCH, nP - p0);
      const res = tf.tidy(() => {
        const input = tf.tensor3d(mel.subarray(p0 * PATCH * 96, (p0 + nb) * PATCH * 96), [nb, PATCH, 96]);
        // second placeholder is the "is training" flag (false at inference).
        // The heads were trained on the 200-d embedding *before* ReLU, but the converter fused
        // MatMul+BiasAdd+ReLU into one op, so take the layer before it and apply dense/kernel + bias ourselves.
        const pre = base.execute({ 'model/Placeholder': input, 'model/Placeholder_1': tf.tensor([false], [1], 'bool') }, 'model/batch_normalization_9/batchnorm/add_1');
        const emb = tf.add(tf.matMul(pre, base.weights['dense/kernel'][0]), base.weights['dense/bias'][0]);
        return ['danceability', 'voice_instrumental', 'mood_party'].map(h => heads[h].execute(emb));
      });
      const [d, v, pa] = await Promise.all(res.map(t => t.array()));
      res.forEach(t => t.dispose());
      for (let i = 0; i < nb; i++) { dance.push(d[i][0]); voice.push(v[i][1]); party.push(pa[i][1]); }
      await sleep(0);
    }
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    // song-level scores from the body of the song (skip the first 15% and last 10%: intros/outros)
    const idx = dance.map((_, i) => i);
    const body = idx.slice(Math.floor(idx.length * 0.15), Math.ceil(idx.length * 0.9));
    return {
      v: 1,
      patchSec: PATCH_SEC,
      dance: Math.round(mean(body.map(i => dance[i])) * 1000) / 1000,
      party: Math.round(mean(body.map(i => party[i])) * 1000) / 1000,
      vocalShare: Math.round(mean(voice) * 1000) / 1000,
      voice: voice.map(v => Math.round(v * 100) / 100),
    };
  }

  // vocal probability for a time range of the song (max over the patches it touches)
  function vocalAt(ml, t0, t1) {
    if (!ml || !ml.voice) return null;
    const a = Math.max(0, Math.floor(t0 / ml.patchSec)), b = Math.min(ml.voice.length - 1, Math.floor((t1 - 1e-3) / ml.patchSec));
    let m = 0;
    for (let i = a; i <= b; i++) m = Math.max(m, ml.voice[i]);
    return b >= a ? m : null;
  }

  root.DJML = { init, analyzeBlob, vocalAt, state, PATCH_SEC, selfTest, CFG };
})(window);
