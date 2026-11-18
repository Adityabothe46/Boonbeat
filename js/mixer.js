/* Two-deck mixer: beat-matched blends with bass swap, filter drops, and smooth fades. */
(function (root) {
  'use strict';

  const dB = v => Math.pow(10, v / 20);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const wrap = v => v - Math.round(v); // to [-0.5, 0.5]
  // piecewise-linear curve through points (xs ascending, duplicates allowed: the later value wins)
  function pw(xs, ys, u) {
    if (u <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) {
      if (u < xs[i]) {
        const span = xs[i] - xs[i - 1];
        return span > 0 ? ys[i - 1] + (ys[i] - ys[i - 1]) * (u - xs[i - 1]) / span : ys[i];
      }
    }
    return ys[ys.length - 1];
  }
  // EQ shelf value in [-1, 1] -> dB (1 = flat, -1 = -26 dB cut)
  const shelf = v => (v >= 1 ? 0 : -26 * (1 - v) / 2);


  // Beat grid with the song's correction map (analysis.gridCorr): for songs whose beats slowly wander,
  // the real beat k sits a little off the straight grid; interpolate that offset.
  function corrAt(a, b) {
    const c = a && a.gridCorr;
    if (!c || !c.length) return 0;
    if (b <= c[0][0]) return c[0][1];
    const n = c.length;
    if (b >= c[n - 1][0]) return c[n - 1][1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m][0] <= b) lo = m; else hi = m; }
    const [b0, s0] = c[lo], [b1, s1] = c[hi];
    return s0 + ((s1 - s0) * (b - b0)) / (b1 - b0 || 1);
  }
  function gridTime(a, b) { return a.beatOffset + b * (60 / a.bpm) + corrAt(a, b); }
  function gridBeat(a, t) {
    const bl = 60 / a.bpm;
    const b0 = (t - a.beatOffset) / bl;
    return (t - a.beatOffset - corrAt(a, b0)) / bl;
  }

  /* ---------- structure-aware transition planning (pure, so the song picker can simulate it) ----------
     Rules (from real DJ practice and the open-source Vande Veire auto-DJ):
     - Phrases are 4/8 bars; every cue sits on a section boundary.
     - Rolling: overlap the next song's intro/build under the end of the current chorus/drop
       (up to 16 bars), then at the boundary swap the bass so the next drop hits on the one.
     - Double drop: both songs hit a drop on the same bar (only when tempo and key match well).
     - Play length comes from the music: a song plays until it has delivered its main sections.
     - Avoid two vocals at once: if they'd overlap, try a shorter lead-in (16 -> 8 -> 4 bars). */
  function structPlan(A, B, curBar, playStart, modeCfg, dev, opts) {
    if (!A || !B || !A.sections || !B.sections) return null;
    const barT = k => gridTime(A, k * 4);
    const lastBarA = A.sections[A.sections.length - 1].bar + A.sections[A.sections.length - 1].bars;
    const secB = B.sections, lastBarB = secB[secB.length - 1].bar + secB[secB.length - 1].bars;

    // incoming cue: its first drop (low -> high), the bars before it are the lead-in
    let dIn = null;
    for (let i = 1; i < secB.length; i++) if (secB[i].h && !secB[i - 1].h) { dIn = secB[i].bar; break; }
    if (dIn == null) dIn = secB[0].h ? secB[0].bar : (secB[1] ? secB[1].bar : secB[0].bar);
    // the song starts straight on its drop (common for DJ edits): no intro to overlap, so line its 8th
    // (or 4th) bar up with the switch instead, and let its first bars play quietly under the outgoing song
    if (dIn - secB[0].bar < 4) {
      const firstLen = secB[0].bars || 0;
      dIn = secB[0].bar + (firstLen >= 12 ? 8 : 4);
    }
    const introBars = dIn - secB[0].bar;

    // outgoing boundaries
    const hEnds = [], hStarts = [];
    let hSeen = 0;
    A.sections.forEach((s, i) => {
      const next = A.sections[i + 1];
      if (s.h) hSeen++;
      if (s.h && (!next || !next.h)) hEnds.push({ bar: s.bar + s.bars, hSeen, why: next ? (next.type === 'outro' ? 'outro starts' : 'breakdown starts') : 'song ends' });
      else if (s.h && next && next.h && next.lvl < s.lvl - 2) hEnds.push({ bar: s.bar + s.bars, hSeen, why: 'energy steps down', soft: true });
      if (s.h && i > 0 && !A.sections[i - 1].h) hStarts.push({ bar: s.bar, hSeen: hSeen - 1 });
    });

    let F, sOut, style, why;
    if (opts.now && opts.short) {
      // skip: get out fast, a 2-bar lead-in and switch on the next bar line (not the next phrase)
      F = Math.min(2, introBars);
      sOut = Math.ceil(curBar + 1 + F);
      style = 'skip';
    } else if (opts.now) {
      F = Math.min(8, introBars);
      // next phrase (4-bar) boundary that leaves room for the lead-in
      sOut = Math.ceil((curBar + 1 + F) / 4) * 4;
      const near = hEnds.find(h => h.bar >= curBar + 1 + F && h.bar <= sOut + 8);
      if (near && !opts.short) { sOut = near.bar; why = near.why; }
      style = opts.short ? 'skip' : 'quick';
    } else {
      const minPlay = modeCfg.minPlay || 90, needH = modeCfg.needH || 2;
      const ok = h => h.bar - 1 > curBar + 2 && barT(h.bar) - playStart >= minPlay && h.hSeen >= Math.min(needH, hSeen);
      const future = h => h.bar - 1 > curBar + 2;
      const dbl = opts.allowDouble && dev < 0.03 && hStarts.find(h => future(h) && barT(h.bar) - playStart >= minPlay && h.hSeen >= 1 && introBars >= 8);
      if (dbl) { sOut = dbl.bar; style = 'double'; why = 'both drops hit together'; }
      else {
        // first boundary that satisfies the play rules; if that's too far into a long song,
        // take the latest musical boundary before the max play time instead
        const maxPlay = modeCfg.maxPlay || 1e9;
        const el = h => barT(h.bar) - playStart;
        let pick = hEnds.find(h => ok(h) && !h.soft) || hEnds.find(ok);
        if (pick && el(pick) > maxPlay) {
          const early = hEnds.filter(h => future(h) && h.hSeen >= 1 && el(h) >= minPlay * 0.8 && el(h) <= maxPlay).pop();
          if (early) pick = early;
        }
        pick = pick || hEnds.filter(future).pop();
        if (!pick) return null;
        sOut = pick.bar; style = 'rolling'; why = pick.why;
        // the song's last section runs right to its end: switch a phrase earlier so it can bow out over 8 bars
        if (lastBarA - sOut < 4) {
          const earlier = Math.floor((lastBarA - 8) / 4) * 4;
          if (earlier - 1 > curBar + 2) { sOut = earlier; why = 'last phrase, so the song finishes smoothly'; }
        }
      }
      F = Math.min(16, Math.floor(introBars / 4) * 4 || introBars);
      F = Math.min(F, Math.max(0, Math.floor(sOut - curBar - 1)));
    }
    if (sOut > lastBarA) sOut = lastBarA;
    // bigger tempo gaps get shorter overlaps (stretching vocals far for 16 bars sounds off)
    if (dev > 0.05 && F > 8) F = 8;
    if (opts.fadeIn != null) F = Math.min(F, opts.fadeIn);
    // a skip should be over fast: 2-bar fade-out after the switch
    const Fo = Math.max(1, Math.min(style === 'double' ? 4 : style === 'skip' ? 2 : 8, lastBarA - sOut, lastBarB - dIn));
    // up to ~14% apart we can still blend by bridging the tempo (see planFromStructure); beyond that, filter drop
    if (dev > 0.145 && !opts.anyTempo) return null;

    // vocal clash check, and a shorter lead-in if that avoids it
    let clash = vocalClash(A, B, sOut, dIn, F, Fo);
    if (clash > 0 && !opts.now) {
      // never shorter than 4 bars of lead-in: a hard cut is worse than a brief vocal overlap
      for (const f2 of [8, 4]) {
        if (f2 >= F) continue;
        const c2 = vocalClash(A, B, sOut, dIn, f2, Fo);
        if (c2 != null && c2 < clash) { clash = c2; F = f2; if (c2 === 0) break; }
      }
    }
    return { style, sOut, dIn, F, Fo, why, clash };
  }

  // bars where both songs are audibly singing during the planned blend (null if we have no vocal data)
  function vocalClash(A, B, sOut, dIn, F, Fo) {
    const V = root.DJML;
    if (!V || !A.ml || !B.ml) return null;
    const blA = 4 * 60 / A.bpm, blB = 4 * 60 / B.bpm;
    let n = 0;
    for (let k = 0; k < F + Fo; k++) {
      // audible: incoming from the 2nd lead-in bar on; outgoing until halfway through its fade-out
      const inAud = k >= 1, outAud = k < F + Fo / 2;
      if (!inAud || !outAud) continue;
      const tA = gridTime(A, (sOut - F + k) * 4), tB = gridTime(B, (dIn - F + k) * 4);
      const va = V.vocalAt(A.ml, tA, tA + blA), vb = tB >= 0 ? V.vocalAt(B.ml, tB, tB + blB) : 0;
      if (va > 0.75 && vb > 0.75) n++;
    }
    return n;
  }

  class Deck {
    constructor(ctx, out, name) {
      this.ctx = ctx; this.name = name;
      this.el = new Audio();
      this.el.crossOrigin = 'anonymous';
      this.el.preload = 'auto';
      this.el.preservesPitch = true;
      this.src = ctx.createMediaElementSource(this.el);
      this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220;
      this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.7;
      this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4000;
      this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.9;
      // loudness match: every song plays at about the same level (set per song in load())
      this.trim = ctx.createGain(); this.trim.gain.value = 1;
      this.gain = ctx.createGain(); this.gain.gain.value = 0;
      this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 256;
      this.src.connect(this.low).connect(this.mid).connect(this.high).connect(this.hp).connect(this.trim).connect(this.gain);
      this.gain.connect(out); this.gain.connect(this.analyser);
      // echo-out: a beat-synced delay after the fader, so the tail keeps ringing after the song stops
      this.echoSend = ctx.createGain(); this.echoSend.gain.value = 0;
      this.delay = ctx.createDelay(2); this.delay.delayTime.value = 0.375;
      this.fb = ctx.createGain(); this.fb.gain.value = 0.5;
      this.echoOut = ctx.createGain(); this.echoOut.gain.value = 0.8;
      this.gain.connect(this.echoSend).connect(this.delay).connect(this.fb).connect(this.delay);
      this.delay.connect(this.echoOut).connect(out);
      this.track = null; this.url = null;
    }
    async load(track, blob) {
      if (this.url) URL.revokeObjectURL(this.url);
      this.track = track;
      this.url = URL.createObjectURL(blob);
      this.el.src = this.url;
      this.el.playbackRate = 1;
      // body loudness from the analysis (~75th percentile of per-second level); aim for -11 dB, at most -8/+5 dB
      const body = track.a && track.a.bodyDb;
      const trimDb = body != null && isFinite(body) ? clamp(-11 - body, -8, 5) : 0;
      this.trim.gain.setValueAtTime(Math.pow(10, trimDb / 20), this.ctx.currentTime);
      await new Promise((res, rej) => {
        // a broken or odd file can leave the player waiting forever: give up after 20 s
        const timer = setTimeout(() => { cleanup(); rej(new Error('this file took too long to open')); }, 20000);
        const ok = () => { cleanup(); res(); };
        const bad = () => { cleanup(); rej(new Error('cannot play this file')); };
        const cleanup = () => { clearTimeout(timer); this.el.removeEventListener('canplay', ok); this.el.removeEventListener('error', bad); };
        this.el.addEventListener('canplay', ok); this.el.addEventListener('error', bad);
      });
      this.reset();
    }
    reset() {
      const t = this.ctx.currentTime;
      for (const p of [this.low.gain, this.mid.gain, this.high.gain]) { p.cancelScheduledValues(t); p.setValueAtTime(0, t); }
      this.hp.frequency.cancelScheduledValues(t); this.hp.frequency.setValueAtTime(10, t);
      // stop feeding the echo (whatever is already in it rings out on its own)
      this.echoSend.gain.cancelScheduledValues(t); this.echoSend.gain.setValueAtTime(0, t);
    }
    set(param, v, tc = 0.04) { param.setTargetAtTime(v, this.ctx.currentTime, tc); }
    get time() { return this.el.currentTime; }
    get rate() { return this.el.playbackRate; }
    set rate(r) { this.el.playbackRate = clamp(r, 0.5, 2); }
    get a() { return this.track && this.track.a; }
    beatLen() { return 60 / this.a.bpm; }
    beatPos(t = this.time) { return gridBeat(this.a, t); }
    timeOfBeat(b) { return gridTime(this.a, b); }
    stop() { this.el.pause(); this.gain.gain.cancelScheduledValues(this.ctx.currentTime); this.gain.gain.setValueAtTime(0, this.ctx.currentTime); }
  }

  class Mixer {
    constructor() {
      this.ctx = new (root.AudioContext || root.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3; this.limiter.knee.value = 4; this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003; this.limiter.release.value = 0.15;
      this.bus = this.ctx.createGain();
      this.bus.connect(this.limiter).connect(this.master).connect(this.ctx.destination);
      this.decks = [new Deck(this.ctx, this.bus, 'A'), new Deck(this.ctx, this.bus, 'B')];
      this.cur = 0;
      this.plan = null;        // upcoming transition
      this.tx = null;          // running transition
      this.paused = false;
      this.playStart = 0;      // track-time where the current song started
      this.onTransitionDone = null;
      this.onEnded = null;
      this.lastPhaseErr = 0;
      this.timer = setInterval(() => this.tick(), 40);
      for (const d of this.decks) d.el.addEventListener('ended', () => {
        if (d.track && d === this.current && !this.tx && this.onEnded) this.onEnded();
      });
    }
    get current() { return this.decks[this.cur]; }
    get other() { return this.decks[1 - this.cur]; }

    async resume() { if (this.ctx.state !== 'running') await this.ctx.resume(); }
    // iPhones only let a page start audio right after a tap. Call this inside the Start tap: it plays a
    // moment of silence on both decks, which unlocks them for the rest of the night.
    unlock() {
      const silent = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
      for (const d of this.decks) {
        // only pause the silence itself: a real song may already have been loaded into this deck
        try { d.el.src = silent; const p = d.el.play(); if (p && p.then) p.then(() => { if (d.el.src === silent) d.el.pause(); }, () => {}); } catch (e) { /* fine */ }
      }
      try { this.ctx.resume(); } catch (e) { /* fine */ }
    }
    setVolume(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

    async startFirst(track, blob) {
      await this.resume();
      const d = this.current;
      await d.load(track, blob);
      const a = track.a;
      d.el.currentTime = Math.max(0, a.firstSound - 0.05);
      this.playStart = d.el.currentTime;
      d.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      d.gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 1.2);
      await d.el.play();
    }

    async prepareNext(track, blob) {
      const d = this.other;
      d.stop();
      await d.load(track, blob);
      return d;
    }

    /* Build the transition plan from the current song into the loaded next song. */
    makePlan(modeCfg, opts = {}) {
      const out = this.current, inn = this.other;
      if (!out.track || !inn.track) return null;
      const A = out.a, B = inn.a;
      const now = out.time;
      const canBeat = modeCfg.beatmatch && A.beatSync && B.beatSync;
      let ratio = null;
      if (canBeat) {
        ratio = root.DJBrain.tempoRatio(A.bpm * out.rate, B.bpm);
        // incoming plays at ratio.rate; with half/double time the beat grid maps 2:1
      }
      const quick = !!opts.now;

      // Structure-aware plans: cut where a chorus/drop ends, land the next song's drop on that exact bar.
      if (canBeat && A.sections && B.sections) {
        const sp = this.planFromStructure(modeCfg, ratio, opts);
        if (sp) return sp;
      }

      if (canBeat && Math.abs(ratio.rate - 1) <= 0.08 && !(A.sections && B.sections)) {
        const bl = out.beatLen();
        const curBeat = out.beatPos(now);
        let lenBeats, startBeat;
        if (quick) {
          lenBeats = opts.short ? 8 : 16;
          startBeat = Math.ceil((curBeat + 2) / 4) * 4;
        } else {
          const outroBeats = (A.lastSound - A.outroStart) / bl;
          const introBeats = (B.introEnd - B.firstSound) / (60 / B.bpm);
          lenBeats = outroBeats >= 16 && introBeats >= 16 ? 32 : 16;
          const len = opts.playLen || 180;
          let endT = modeCfg.full ? A.outroStart : Math.min(A.outroStart, this.playStart + len);
          endT = Math.max(endT, now + 20);
          startBeat = Math.floor(out.beatPos(endT) / 16) * 16;
          if (out.timeOfBeat(startBeat) < now + 8) startBeat = Math.ceil((curBeat + 8) / 4) * 4;
          while (startBeat > curBeat + 8 && out.timeOfBeat(startBeat + lenBeats) > A.lastSound - 0.5) startBeat -= 4;
          if (out.timeOfBeat(startBeat + lenBeats) > A.lastSound) lenBeats = 8;
        }
        // incoming starts on its first downbeat at/after first sound
        const bIn = 60 / B.bpm;
        let inBeat = Math.ceil((B.firstSound - B.beatOffset) / bIn / 4 - 0.05) * 4;
        if (gridTime(B, inBeat) < 0) inBeat += 4;
        return {
          type: 'beat', startBeat, lenBeats, inBeat, mult: ratio.mult, rate: ratio.rate,
          startTime: out.timeOfBeat(startBeat), label: `${lenBeats}-beat blend`,
        };
      }
      if (modeCfg.beatmatch && A.beatSync) {
        // tempos too far apart: filter sweep out, then drop the next song on the beat
        const curBeat = out.beatPos(now);
        let startBeat;
        // with structure: sweep out over the last 4 bars of the chorus, then slam the next song in on its drop
        const sp = A.sections && B.sections ? this.planFromStructure(modeCfg, { rate: 1, mult: 1 }, { ...opts, anyTempo: true }) : null;
        if (sp) {
          const sw = Math.round(out.beatPos(sp.switchTime));
          startBeat = Math.max(Math.ceil(curBeat + 1), sw - 16);
          return { type: 'drop', startBeat, lenBeats: sw - startBeat, startTime: out.timeOfBeat(startBeat), switchTime: sp.switchTime,
            inStartTime: sp.dropIn, dropIn: sp.dropIn, label: 'filter drop', why: sp.why.replace(/^[^:]+/, 'Filter drop').replace(/, (no vocal clash|vocals overlap \d+ bars?)$/, '') + ' (tempos too far apart to blend)' };
        }
        if (quick) startBeat = Math.ceil((curBeat + 2) / 4) * 4;
        else {
          const endT = Math.max(now + 20, Math.min(A.outroStart, this.playStart + (opts.playLen || 180)));
          startBeat = Math.floor(out.beatPos(endT) / 16) * 16 + 8;
          if (out.timeOfBeat(startBeat) < now + 6) startBeat = Math.ceil((curBeat + 6) / 4) * 4;
        }
        return { type: 'drop', startBeat, lenBeats: 8, startTime: out.timeOfBeat(startBeat), label: 'filter drop' };
      }
      // smooth fade
      const fade = quick ? (opts.short ? 2.5 : 5) : modeCfg.fadeSec;
      let startTime;
      if (quick) startTime = now + 0.1;
      else if (modeCfg.full) startTime = Math.min(A.outroStart + 2, A.lastSound - fade);
      else startTime = Math.min(A.outroStart, this.playStart + (opts.playLen || 180));
      startTime = Math.max(startTime, now + (quick ? 0.1 : 10));
      startTime = Math.min(startTime, Math.max(now + 0.1, A.lastSound - fade));
      return { type: 'fade', startTime, lenSec: fade, label: `${Math.round(fade)}s fade` };
    }

    planFromStructure(modeCfg, ratio, opts) {
      const out = this.current, inn = this.other, A = out.a, B = inn.a;
      if (ratio.mult !== 1) return null;
      const dev = Math.abs(ratio.rate - 1);
      const bp = structPlan(A, B, out.beatPos(out.time) / 4, this.playStart, modeCfg, dev, opts);
      if (!bp) return null;
      const { style, sOut, dIn, F, Fo, why } = bp;
      const barT = k => out.timeOfBeat(k * 4);
      const fmtT = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
      const switchTime = barT(sOut);
      const vox = bp.clash == null ? '' : bp.clash === 0 ? ', no vocal clash' : `, vocals overlap ${bp.clash} bar${bp.clash > 1 ? 's' : ''}`;
      // Tempo bridge (a DJ riding the pitch fader): for gaps over 6%, ease the playing song's tempo
      // toward the next one over the 16 bars before the blend, so neither song moves more than ~7%.
      let bridge = null;
      if (dev > 0.06 && !opts.now) {
        const R = (B.bpm * ratio.mult) / A.bpm;            // what the outgoing would need to match fully
        const ro = clamp(Math.sqrt(R), 0.93, 1.07);         // outgoing goes half way (in rate terms)
        const startT = barT(sOut - F);
        bridge = { from: barT(Math.max(0, sOut - F - 16)), to: startT, start: out.rate, rate: ro };
      }
      return {
        type: 'beat', style, rate: ratio.rate, mult: 1, clash: bp.clash, bridge,
        startBeat: (sOut - F) * 4, inBeat: (dIn - F) * 4, lenBeats: (F + Fo) * 4, fadeIn: F, fadeOut: Fo,
        startTime: barT(sOut - F), switchTime,
        cueIn: gridTime(B, (dIn - F) * 4), dropIn: gridTime(B, dIn * 4),
        label: style === 'double' ? `double drop (${F} bars)` : style === 'rolling' ? `${F + Fo}-bar blend` : `${F + Fo}-bar mix`,
        why: `${style === 'double' ? 'Double drop' : style === 'rolling' ? 'Rolling' : 'Quick mix'}: switch at ${fmtT(switchTime)} (${why || 'next phrase'}), next song's drop lands on the one${vox}${bridge ? `, tempo eased ${((bridge.rate - 1) * 100).toFixed(1)}% first` : ''}`,
      };
    }

    schedule(plan) { this.plan = plan; }

    /* Jump within the playing song (like a DJ's beat jump): land on the same beat of the bar you were on,
       so the groove doesn't stumble. Returns the new time, or null if a blend is running. */
    seek(t) {
      if (this.tx) return null;
      const d = this.current, a = d.a;
      if (!d.track || !a) return null;
      let target = Math.max(0, Math.min(a.duration - 3, t));
      if (a.beatSync) {
        const cur = gridBeat(a, d.time), want = gridBeat(a, target);
        const jumpBars = Math.round((want - cur) / 4);
        target = Math.max(0, gridTime(a, cur + jumpBars * 4));
      }
      this.plan = null; // the old mix point may now be behind us; caller replans
      d.el.currentTime = target;
      return target;
    }

    beginTransition() {
      const p = this.plan; this.plan = null;
      const out = this.current, inn = this.other;
      const B = inn.a;
      const t = this.ctx.currentTime;
      inn.reset();
      if (p.type === 'beat') {
        const r = root.DJBrain.tempoRatio(out.a.bpm * out.rate, B.bpm);
        if (r.mult === p.mult) p.rate = r.rate;
        inn.rate = p.rate;
        // where the incoming song should be right now so its inBeat lands on out's startBeat
        const outBeat = out.beatPos();
        const beatsUntil = (p.startBeat - outBeat) / p.mult;
        const inTime = gridTime(B, p.inBeat - beatsUntil);
        inn.gain.gain.cancelScheduledValues(t); inn.gain.gain.setValueAtTime(0, t);
        inn.low.gain.setValueAtTime(-26, t);
        if (inTime >= 0) { inn.el.currentTime = inTime; inn.el.play(); }
        else {
          // the cue falls before the file starts: hold it and press play on the out-beat where 0:00 is due
          inn.el.pause(); inn.el.currentTime = 0;
          p.waitIn = true;
          p.inZeroBeat = p.startBeat + p.mult * (gridBeat(B, 0) - p.inBeat);
        }
      } else if (p.type === 'fade') {
        inn.rate = 1;
        inn.el.currentTime = Math.max(0, B.firstSound - 0.05);
        inn.gain.gain.cancelScheduledValues(t); inn.gain.gain.setValueAtTime(0, t);
        inn.el.play();
      } else {
        inn.rate = 1;
      }
      this.tx = { ...p, began: performance.now(), outStartTime: out.time };
    }

    finishTransition() {
      const out = this.current, inn = this.other;
      out.stop(); out.reset();
      inn.set(inn.gain.gain, 1, 0.05);
      inn.set(inn.low.gain, 0, 0.05);
      inn.set(inn.high.gain, 0, 0.05);
      inn.set(inn.mid.gain, 0, 0.05);
      inn.set(inn.hp.frequency, 10, 0.05);
      this.cur = 1 - this.cur;
      this.playStart = inn.time;
      const done = this.tx; this.tx = null;
      if (this.onTransitionDone) this.onTransitionDone(done);
    }

    tick() {
      const out = this.current, inn = this.other;
      if (!out.track || this.paused) return;
      // rate drift back to natural tempo after a blend
      const br = this.plan && this.plan.bridge;
      if (br && !this.tx && out.time >= br.from) {
        const u = clamp((out.time - br.from) / Math.max(1, br.to - br.from), 0, 1);
        out.rate = br.start + (br.rate - br.start) * u;
      } else if (!this.tx && Math.abs(out.rate - 1) > 0.0005) {
        const step = 0.0001; // ~0.25%/s back to natural tempo after a blend
        out.rate = out.rate + Math.sign(1 - out.rate) * Math.min(step, Math.abs(1 - out.rate));
      }
      if (this.plan && !this.tx) {
        const lead = this.plan.type === 'beat' ? 2 * out.beatLen() : 0;
        if (out.time >= this.plan.startTime - lead) this.beginTransition();
      }
      const p = this.tx;
      if (!p) return;

      if (p.type === 'beat') {
        const ob = out.beatPos();
        const prog = (ob - p.startBeat) / p.lenBeats;
        if (p.waitIn) {
          if (ob < p.inZeroBeat) return;
          p.waitIn = false; inn.el.currentTime = 0; inn.el.play();
        }
        // phase lock: compare beat phase (allow half/double time)
        const ib = inn.beatPos() * p.mult;
        const target = p.inBeat * p.mult + (ob - p.startBeat);
        const raw = target - ib;
        const err = wrap(raw); // in out-beats, positive = incoming behind
        this.lastPhaseErr = err * out.beatLen() * 1000;
        const inT = gridTime(inn.a, target / p.mult);
        // whole-beat slips (bars out of line) or big phase errors: reseek while the incoming is still quiet
        if (inT > 0.05 && ((Math.abs(err) > 0.25 && prog < 0) || (Math.abs(raw) > 0.5 && prog < 0.2))) {
          inn.el.currentTime = inT;
        } else {
          inn.rate = p.rate * (1 + clamp(err * out.beatLen() * 1.2, -0.04, 0.04));
        }
        if (prog < 0) return;
        let swapped;
        if (p.fadeIn != null) {
          // DJ curves in bars (after Vande Veire's auto-DJ): incoming creeps in with bass and highs cut,
          // the bass swaps exactly on the switch bar, then the outgoing song bows out.
          const u = (ob - p.startBeat) / 4, P = p.fadeIn, Lt = p.fadeIn + p.fadeOut;
          const X = [0, Math.min(1, P / 2), P / 2, P, P + Math.min(1, Lt - P), P + (Lt - P) / 2, Lt];
          const c = curve => pw(X, curve, u);
          let vM = c([1, 1, 1, 1, 0.8, 0.8, 0]), vS = c([0, 0.2, 0.8, 0.8, 1, 1, 1]);
          vM = Math.sqrt(Math.max(0, vM)); vS = Math.sqrt(Math.max(0, vS));
          const sum = vM * vM + vS * vS, norm = sum > 1 ? Math.pow(1 / Math.sqrt(sum), 0.5) : 1;
          swapped = u >= P;
          out.set(out.gain.gain, vM * norm, 0.03);
          inn.set(inn.gain.gain, vS * norm, 0.03);
          out.set(out.low.gain, swapped ? -26 : 0, 0.02);
          inn.set(inn.low.gain, swapped ? 0 : -26, 0.02);
          // mids: the incoming song's melody sits back until the switch, then the outgoing one does
          inn.set(inn.mid.gain, swapped ? 0 : -6, 0.1);
          out.set(out.mid.gain, swapped ? -5 : 0, 0.1);
          out.set(out.high.gain, shelf(c([1, 1, 1, 1, 0.2, -1, -1])), 0.05);
          inn.set(inn.high.gain, shelf(c([-1, -1, -1, 0.2, 1, 1, 1])), 0.05);
        } else {
          const g = Math.min(1, prog / 0.5);
          inn.set(inn.gain.gain, Math.sin(g * Math.PI / 2), 0.03);
          out.set(out.gain.gain, prog < 0.5 ? 1 : Math.cos(Math.min(1, (prog - 0.5) / 0.5) * Math.PI / 2), 0.03);
          swapped = prog >= 0.5;
          inn.set(inn.low.gain, swapped ? 0 : -26, 0.08);
          out.set(out.low.gain, swapped ? -26 : 0, 0.08);
          out.set(out.high.gain, prog > 0.75 ? -6 : 0, 0.2);
        }
        if (swapped && p.phaseAtSwitch == null) p.phaseAtSwitch = this.lastPhaseErr;
        p.progress = prog; p.swapped = swapped;
        if (prog >= 1 || out.el.ended) { p.progress = 1; this.finishTransition(); }
      } else if (p.type === 'drop') {
        const ob = out.beatPos();
        const prog = (ob - p.startBeat) / p.lenBeats;
        if (prog < 0) return;
        const f = 10 * Math.pow(120, Math.min(1, prog)); // 10 Hz -> 1.2 kHz
        out.set(out.hp.frequency, f, 0.05);
        out.set(out.gain.gain, Math.max(0, 1 - prog * prog), 0.05);
        if (!p.echo && prog >= 0.75) {
          p.echo = true;
          out.delay.delayTime.setValueAtTime(clamp(out.beatLen() * 0.75, 0.1, 1.5), this.ctx.currentTime); // dotted-eighth echo
          out.set(out.echoSend.gain, 0.9, 0.05);
        }
        p.progress = prog;
        if (prog >= 1) {
          const B = inn.a, bIn = 60 / B.bpm;
          let inBeat = Math.ceil((B.firstSound - B.beatOffset) / bIn / 4 - 0.05) * 4;
          const startAt = p.inStartTime != null ? p.inStartTime : gridTime(B, inBeat);
          inn.el.currentTime = Math.max(0, startAt - 0.02);
          inn.gain.gain.setValueAtTime(1, this.ctx.currentTime);
          inn.el.play();
          this.finishTransition();
        }
      } else {
        const prog = (out.time - p.outStartTime) / p.lenSec;
        const g = clamp(prog, 0, 1);
        inn.set(inn.gain.gain, Math.sin(g * Math.PI / 2), 0.05);
        out.set(out.gain.gain, Math.cos(g * Math.PI / 2), 0.05);
        p.progress = g;
        if (prog >= 1 || out.el.ended) this.finishTransition();
      }
    }

    // next song loaded but current already ended (e.g. slow download)
    async hardStart() {
      const out = this.current, inn = this.other;
      out.stop();
      this.cur = 1 - this.cur;
      inn.rate = 1;
      inn.el.currentTime = Math.max(0, inn.a.firstSound - 0.05);
      inn.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      inn.gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 0.6);
      this.playStart = inn.el.currentTime;
      await inn.el.play();
    }

    async togglePause() {
      await this.resume();
      this.paused = !this.paused;
      for (const d of this.decks) {
        if (!d.track) continue;
        const active = d === this.current || (this.tx && this.tx.type !== 'drop');
        if (this.paused) d.el.pause();
        else if (active && (d === this.current || this.tx)) d.el.play();
      }
      return this.paused;
    }
  }

  root.DJMixer = { Mixer, structPlan, vocalClash, gridTime, gridBeat };
})(window);
