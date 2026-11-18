/* App wiring: state, song loading pipeline, UI. */
(function () {
  'use strict';
  const B = window.DJBrain, Src = window.DJSources, An = window.DJAnalysis;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const rand = (a, b) => a + Math.random() * (b - a);

  /* ---------- persistence ---------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('aidj.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('aidj.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('aidj', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('analysis');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }).catch(() => null);
    return dbp;
  }
  async function cacheGet(id) {
    const d = await db(); if (!d) return null;
    return new Promise(res => { const q = d.transaction('analysis').objectStore('analysis').get(id); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  }
  async function cachePut(id, v) {
    const d = await db(); if (!d) return;
    try { d.transaction('analysis', 'readwrite').objectStore('analysis').put(v, id); } catch (e) { /* ignore */ }
  }

  /* ---------- state ---------- */
  const saved = LS.get('settings', {});
  const S = {
    mode: saved.mode || 'dance',
    lang: saved.lang || 'mix',
    volume: saved.volume != null ? saved.volume : 0.9,
    energyAuto: true, energyManual: 0.8,
    pool: new Map(),
    fetched: new Set(),
    played: new Set(),
    history: [],
    recentLangs: [],
    requests: [],
    rejected: new Set(),
    next: null,
    loadingNext: false,
    gen: 0,
    started: false,
    waitingHard: false,
  };
  const overrides = LS.get('over', {});
  let mixer = null;

  function applyOverrides(t) {
    const o = overrides[t.id];
    if (o) { if (o.lang) t.langManual = o.lang; if (o.mood) t.moodManual = o.mood; }
    return t;
  }
  // the same song is often uploaded several times: keep the best-loved copy
  const dupKey = t => (t.title || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9ऀ-੿]+/g, '') + '|' + Math.round((t.duration || 0) / 4);
  S.dups = new Map();
  function addToPool(list) {
    for (const t of list) {
      if (S.pool.has(t.id)) continue;
      const k = dupKey(t), prevId = S.dups.get(k), prev = prevId && S.pool.get(prevId);
      if (prev) {
        const better = B.popularity(t) > B.popularity(prev) && !S.played.has(prev.id) && !(S.crate && S.crate.has(prev.id)) && S.next !== prev;
        if (!better) continue;
        S.pool.delete(prev.id);
      }
      S.pool.set(t.id, applyOverrides(t));
      S.dups.set(k, t.id);
    }
  }
  function mode() { return B.MODES[S.mode]; }
  function energyTarget() { return S.energyAuto ? mode().target(S.history.length) : S.energyManual; }
  function ctxFor(current) {
    return { mode: S.mode, lang: S.lang, played: S.played, history: S.history, recentLangs: S.recentLangs, energyTarget: energyTarget(), current,
      theme: theme(), langBlock: S.langBlock, taste: window.DJTaste };
  }
  // style centroid the next song should stay close to (Vande Veire: 0.4 set start + 0.66 current - 0.06 previous)
  function theme() {
    const st = t => t && t.a && t.a.style;
    const cur = st(S.history[S.history.length - 1]);
    if (!cur) return null;
    const prev = st(S.history[S.history.length - 2]) || cur, init = S.themeInit || cur;
    return cur.map((v, i) => 0.4 * init[i] + 0.66 * v - 0.06 * prev[i]);
  }
  function status(msg) { $('#status').textContent = msg; }
  function saveSettings() { LS.set('settings', { mode: S.mode, lang: S.lang, volume: S.volume }); }

  /* ---------- fetching songs ---------- */
  // one feed: 'a:' artist (Audius + hearthis), 'g:' Audius trending genre, 'h:' hearthis genre feed,
  // 'ia:' Internet Archive netlabel subject, otherwise a free-text search on every source
  async function fetchQuery(q, time) {
    if (q.startsWith('g:')) return Src.trending(q.slice(2), time || 'month');
    if (q.startsWith('a:')) return Src.searchArtist(q.slice(2));
    if (q.startsWith('h:')) return Src.hearthisGenre(q.slice(2));
    if (q.startsWith('ia:')) return Src.archive(q.slice(3));
    if (q.startsWith('o:')) return Src.audiusUser(q.slice(2));
    if (q.startsWith('s:')) {
      const [title, artist] = q.slice(2).split('|');
      const main = (artist || '').split(/,|&/)[0].replace(/^yo yo /i, '').trim();
      let found = (await Src.searchAll(`${title} ${main}`.trim())).filter(t => window.DJFav && window.DJFav.match(t));
      // nothing with the artist name: try the song title alone (uploads often leave the artist out)
      if (!found.length && main) found = (await Src.searchAll(title)).filter(t => window.DJFav && window.DJFav.match(t));
      return found;
    }
    return Src.searchAll(q);
  }
  async function ensurePool() {
    const qs = B.queriesFor(S.mode, S.lang).filter(q => !S.fetched.has(q));
    if (!qs.length) return;
    status(`Finding ${B.MODES[S.mode].label.toLowerCase()} songs…`);
    let i = 0, done = 0, ready;
    // don't make you wait for every search: carry on once the first batch has brought in enough songs,
    // the rest keep arriving in the background
    const enough = new Promise(r => { ready = r; });
    const before = S.pool.size;
    const worker = async () => {
      while (i < qs.length) {
        const q = qs[i++];
        S.fetched.add(q);
        try {
          const list = await fetchQuery(q, 'month');
          addToPool(list);
        } catch (e) { S.fetched.delete(q); console.warn('fetch failed', q, e); }
        done++;
        if (done >= Math.min(10, qs.length) && S.pool.size - before >= 120) ready();
      }
    };
    const all = Promise.all([worker(), worker(), worker()]).then(() => { renderIdeas(); renderFav(); ready(); });
    await Promise.race([enough, all]);
  }

  async function analyse(t, blob) {
    let a = await cacheGet(t.id);
    if (!a || a.v !== 8) {
      // the uploader's BPM tag is a second opinion when our own beat grid doesn't hold
      a = await An.analyzeArrayBuffer(await blob.arrayBuffer(), t.metaBpm);
      cachePut(t.id, a);
    }
    t.a = a; t.duration = a.duration;
    B.noteAnalysed(a.energyRaw);
    return a;
  }

  // AI scores (danceability, party, vocals per 3 s). Skipped quietly if the models can't run.
  async function analyseML(t, blob) {
    const ML = window.DJML;
    if (!ML || ML.state.ready === false) return null;
    let ml = await cacheGet('ml:' + t.id);
    if (!ml || ml.v !== 1) {
      try { ml = await ML.analyzeBlob(blob); } catch (e) { console.warn('[ml] skipped', t.title, e.message); return null; }
      if (ml) cachePut('ml:' + t.id, ml);
    }
    t.ml = ml;
    if (t.a) t.a.ml = ml;
    return ml;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // don't crunch audio during a blend, or in the 25 s before one starts (the mixer must keep perfect time then)
  function mixSoon() {
    if (!mixer) return false;
    if (mixer.tx) return true;
    const p = mixer.plan, cur = mixer.current;
    return !!(p && cur && cur.track && cur.time > p.startTime - 25 && cur.time < p.startTime + 5);
  }
  async function quietTime() { while (mixSoon()) await sleep(400); }

  /* ---------- the crate ----------
     Like a DJ pulling records: keep a few candidates downloaded and fully analysed (beats, structure,
     AI scores) ahead of time, then choose the next song by simulating the actual mix with each one. */
  // phones prepare fewer songs ahead: less downloading, less memory, less background work
  const PHONE = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  const CRATE_SIZE = PHONE ? 3 : 6;
  S.crate = new Map();
  S.filling = false;

  async function loadFull(t) {
    const blob = await Src.fetchAudio(t);
    await quietTime();
    await analyse(t, blob);
    await quietTime();
    await analyseML(t, blob);
    // a favourite teaches the taste memory what you like (tempo, party level, sound)
    const T = window.DJTaste;
    if (window.DJFav && window.DJFav.match(t) && T && !T.rating(t)) T.like(t, B.detectLanguage(t));
    return blob;
  }

  async function fillCrate() {
    if (S.filling || !S.started) return;
    S.filling = true;
    try {
      let misses = 0;
      while (S.started && S.crate.size < CRATE_SIZE && misses < 8) {
        const exclude = new Set([...S.crate.keys(), ...S.rejected, ...(S.next ? [S.next.id] : [])]);
        const cur = mixer && mixer.current.track;
        let t = B.pick([...S.pool.values()], ctxFor(cur), exclude);
        if (!t) { await moreSongs(); t = B.pick([...S.pool.values()], ctxFor(cur), exclude); if (!t) break; }
        try {
          const blob = await loadFull(t);
          if (!fits(t)) { S.rejected.add(t.id); misses++; continue; }
          S.crate.set(t.id, { track: t, blob });
          renderIdeas();
          await maybeUpgradeNext(t, blob);
        } catch (e) { console.warn('load failed', t.title, e); t.bad = true; misses++; }
      }
    } finally { S.filling = false; }
  }

  // A better-matching song turned up in the crate after we'd already cued one: swap it in,
  // as long as the mix is still more than 30 s away and you didn't request the cued song.
  async function maybeUpgradeNext(cand, blob) {
    if (!mixer || !S.next || mixer.tx || !mixer.plan || !S.nextBlob) return;
    if (S.next.pickWhy === 'you requested it') return;
    const lead = (mixer.plan.startTime - mixer.current.time) / (mixer.current.rate || 1);
    if (lead < 30) return;
    const cur = mixer.current.track;
    if (!cur || !cur.a || !cur.a.beatSync) return;
    const ctx = ctxFor(cur), sim = { curBar: mixer.current.beatPos(mixer.current.time) / 4, playStart: mixer.playStart };
    const now = B.transitionScore(S.next, ctx, sim), alt = B.transitionScore(cand, ctx, sim);
    if (!now || !alt || alt.total < now.total + 0.6) return;
    const old = S.next, oldBlob = S.nextBlob, gen = ++S.gen;
    S.crate.delete(cand.id);
    S.crate.set(old.id, { track: old, blob: oldBlob });
    mixer.schedule(null); S.next = null;
    await mixer.prepareNext(cand, blob);
    if (gen !== S.gen || mixer.tx) return;
    S.next = cand; S.nextBlob = blob;
    cand.pickWhy = reasonText(alt.parts) + ' (better match than ' + old.title + ')';
    const plan = mixer.makePlan(mode(), planOpts(cur, cand));
    mixer.schedule(plan);
    console.log('[upgrade]', old.title, now.total.toFixed(2), '->', cand.title, alt.total.toFixed(2));
    status(`Swapped in “${cand.title}”: it fits better than “${old.title}” · ${plan && (plan.why || plan.label)}`);
    renderDeck(0); renderDeck(1); renderNext(); renderIdeas();
  }

  function purgeCrate() {
    for (const [id, c] of S.crate) {
      const t = c.track;
      if (!B.langAllowed(B.detectLanguage(t), S.lang) || !fits(t) || S.played.has(id)) S.crate.delete(id);
    }
    renderIdeas();
  }

  function reasonText(parts) {
    const items = Object.entries(parts).filter(([, v]) => Math.abs(v) >= 0.15).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4);
    return items.map(([k, v]) => `${v > 0 ? '+' : '−'} ${k}`).join(', ');
  }

  // pick the next song: requests first, otherwise the best transition from the crate
  async function chooseNext(current, gen) {
    while (S.requests.length) {
      const r = S.requests.shift();
      if (S.played.has(r.id)) continue;
      const c = S.crate.get(r.id);
      if (c) { S.crate.delete(r.id); r.pickWhy = 'you requested it'; return { track: r, blob: c.blob }; }
      try { status(`Loading your request “${r.title}”…`); const blob = await loadFull(r); r.pickWhy = 'you requested it'; return { track: r, blob }; }
      catch (e) { r.bad = true; }
    }
    fillCrate();
    // wait for a real choice (2+ candidates) when there's time; the first song only needs one
    // first song: take 2 candidates if they arrive within 25 s, otherwise go with what we have
    const want = 2, t0 = Date.now(), maxWait = current ? 30000 : 90000, firstWait = 25000;
    while (S.crate.size < want && Date.now() - t0 < maxWait && (S.filling || S.crate.size === 0)) {
      if (!current && S.crate.size >= 1 && Date.now() - t0 > firstWait) break;
      if (gen !== S.gen) return null;
      status(`Digging through the crate… ${S.crate.size} song${S.crate.size === 1 ? '' : 's'} ready`);
      await sleep(400);
      if (!S.filling && S.crate.size < want) fillCrate();
    }
    if (gen !== S.gen || !S.crate.size) return null;
    const ctx = ctxFor(current);
    let sim = null;
    if (current && current.a && current.a.beatSync && mixer) sim = { curBar: mixer.current.beatPos(mixer.current.time) / 4, playStart: mixer.playStart };
    const scored = [];
    for (const c of S.crate.values()) {
      const r = current && sim ? B.transitionScore(c.track, ctx, sim) : B.scoreDetail(c.track, ctx);
      if (r) scored.push({ c, r });
    }
    if (!scored.length) { purgeCrate(); fillCrate(); return null; }
    scored.sort((a, b) => b.r.total - a.r.total);
    // a little variety: if the top two are basically tied, flip a coin
    const best = scored.length > 1 && scored[0].r.total - scored[1].r.total < 0.15 && Math.random() < 0.5 ? scored[1] : scored[0];
    S.crate.delete(best.c.track.id);
    best.c.track.pickWhy = reasonText(best.r.parts);
    best.c.track.pickScore = Math.round(best.r.total * 100) / 100;
    console.log('[pick]', best.c.track.title, best.r.total.toFixed(2), best.r.parts, 'vs', scored.filter(x => x !== best).map(x => [x.c.track.title, x.r.total.toFixed(2)]));
    fillCrate();
    return { track: best.c.track, blob: best.c.blob };
  }

  // Hard rules for a mode. Party thresholds are from real songs: dance-floor originals score 0.70-0.96,
  // love songs 0.00-0.13. Beat-matched modes also need a beat grid that holds (see analysis gridDrift).
  function fits(t) {
    // your favourites always fit (only slowed/reverb-style versions are skipped)
    if (window.DJFav && window.DJFav.match(t)) return B.versionOf(t) !== 'altered';
    const e = B.energyOf(t), a = t.a, party = t.ml ? t.ml.party : null;
    if (B.versionOf(t) === 'altered') return false;
    if (S.mode === 'dance' || S.mode === 'warmup') {
      if (!a.beatSync) return false;                       // grid doesn't hold: it would sound off-beat
      if (a.bodyDb < -17) return false;                    // quiet master / mostly silent
      if (a.introEnd > 45 && (a.sections || []).filter(x => x.h).length < 2) return false; // long quiet intro, little body
      const floor = S.mode === 'dance' ? 0.5 : 0.35;
      if (party != null && party < floor) return false;    // AI hears a love song / ballad
      if (party == null && e < 0.5) return false;
      const bpm = a.bpm;
      if (bpm < 85 && !(party != null && party > 0.75)) return false; // slow ballad tempo
    }
    if (S.mode === 'romantic' && (e > 0.62 || (party != null && party > 0.35))) return false;
    if (S.mode === 'chill' && (e > 0.72 || (party != null && party > 0.6))) return false;
    return true;
  }

  async function moreSongs() {
    const extra = { dance: ['g:Electronic', 'g:House', 'remix'], warmup: ['g:Deep House', 'remix'], romantic: ['love', 'g:R&B/Soul'], chill: ['g:Lo-Fi', 'chill'] }[S.mode];
    for (const q of extra) {
      if (S.fetched.has('x:' + q)) continue;
      S.fetched.add('x:' + q);
      try { addToPool(await fetchQuery(q, 'allTime')); } catch (e) { /* ignore */ }
    }
    S.rejected.clear();
  }

  /* ---------- the set ---------- */
  async function start() {
    if (S.started) return;
    S.started = true;
    $('#start').disabled = true;
    mixer = new window.DJMixer.Mixer();
    window.DJ.mixer = mixer;
    mixer.setVolume(S.volume);
    await mixer.resume();
    mixer.onTransitionDone = done => { logMix(done); onNowPlaying(mixer.current.track); };
    mixer.onEnded = onEnded;
    await ensurePool();
    const gen = S.gen;
    const first = await chooseNext(null, gen);
    if (!first) { S.started = false; $('#start').disabled = false; return; }
    await mixer.startFirst(first.track, first.blob);
    ['#pause', '#mixnow', '#skip'].forEach(s => { $(s).disabled = false; });
    $('#start').textContent = '● Live';
    keepAwake();
    onNowPlaying(first.track);
  }

  function onNowPlaying(t) {
    S.history.push(t);
    S.played.add(t.id);
    const lang = B.detectLanguage(t);
    S.recentLangs.push(lang);
    if (!S.langBlock || S.langBlock.lang !== lang) S.langBlock = { lang, left: 2 + Math.floor(Math.random() * 2) };
    else S.langBlock.left--;
    if (!S.themeInit && t.a && t.a.style) S.themeInit = t.a.style;
    S.crate.delete(t.id);
    S.next = null;
    showOnLockScreen(t);
    status(`Now playing “${t.title}” by ${t.artist}`);
    renderHistory(); renderDeck(0); renderDeck(1); renderNext();
    preloadNext();
  }

  async function preloadNext() {
    const gen = ++S.gen;
    S.loadingNext = true; renderNext();
    const cur = mixer.current.track;
    const got = await chooseNext(cur, gen);
    if (gen !== S.gen) return;
    S.loadingNext = false;
    if (!got) { renderNext(); return; }
    if (mixer.tx) { S.requests.unshift(got.track); return; }
    await mixer.prepareNext(got.track, got.blob);
    if (gen !== S.gen) return;
    S.next = got.track; S.nextBlob = got.blob;
    const plan = mixer.makePlan(mode(), planOpts(cur, got.track));
    mixer.schedule(plan);
    status(`Next: “${got.track.title}” · ${plan.why || plan.label + ' at ' + fmt(plan.startTime)}`);
    renderDeck(0); renderDeck(1); renderNext(); renderIdeas();
    if (S.waitingHard) { S.waitingHard = false; await mixer.hardStart(); onNowPlaying(mixer.current.track); }
  }

  async function onEnded() {
    if (S.next && mixer.other.track === S.next) { await mixer.hardStart(); onNowPlaying(mixer.current.track); }
    else { S.waitingHard = true; status('Loading the next song…'); }
  }

  function planOpts(cur, nxt) {
    const dd = mode().doubleDrop || 0;
    return {
      playLen: rand(...(mode().playLen || [180, 180])),
      allowDouble: Math.random() < dd && B.keyCompat(B.keyOf(cur), B.keyOf(nxt)) >= 0.8,
    };
  }

  function replan() {
    if (!mixer || !S.next || mixer.tx) return;
    mixer.schedule(mixer.makePlan(mode(), planOpts(mixer.current.track, S.next)));
    renderNext();
  }

  // jump within the playing song, then re-plan the next mix from the new position
  function seekTo(t) {
    if (!mixer) return;
    if (mixer.tx) { status('Mixing right now, jump again once the blend is done.'); return; }
    const at = mixer.seek(t);
    if (at == null) return;
    // songs needn't wait for the minimum play time after you jump past it on purpose
    if (at < mixer.playStart) mixer.playStart = at;
    replan();
    const p = mixer.plan;
    status(`Jumped to ${fmt(at)}${p ? ' · next mix: ' + (p.why || p.label + ' at ' + fmt(p.startTime)) : ''}`);
  }
  function jumpBars(n) {
    if (!mixer || !mixer.current.track) return;
    const d = mixer.current, a = d.a;
    const step = a && a.beatSync ? n * 4 * (60 / a.bpm) : n * 4;
    seekTo(d.time + step);
  }

  function rethinkNext() {
    // settings changed: drop the loaded next song (unless it was requested) and pick again
    if (!mixer || mixer.tx) return;
    mixer.schedule(null);
    S.next = null;
    preloadNext();
  }

  function mixNow(short) {
    if (!mixer) return;
    if (mixer.tx) return;
    if (!S.next) { status('Next song is still loading, one sec…'); return; }
    mixer.schedule(mixer.makePlan(mode(), { now: true, short }));
    status(short ? 'Skipping…' : 'Mixing in the next song on the next bar…');
  }

  /* ---------- mix log ---------- */
  S.mixLog = [];
  function logMix(p) {
    if (!p) return;
    const from = S.history[S.history.length - 1], to = mixer.current.track;
    const entry = {
      from: from && from.title, to: to && to.title, type: p.style || p.type, why: p.why || p.label,
      tempo: p.rate ? ((p.rate - 1) * 100).toFixed(1) + '%' : '0%',
      phaseAtSwitch: p.phaseAtSwitch != null ? Math.round(p.phaseAtSwitch) + ' ms' : null,
      picked: to && to.pickWhy,
    };
    S.mixLog.push(entry);
    console.log('[mix]', entry);
    renderMixLog();
  }
  function renderMixLog() {
    const box = $('#mixlog'); if (!box) return;
    box.innerHTML = '';
    for (const m of S.mixLog.slice().reverse().slice(0, 12)) {
      const d = document.createElement('div'); d.className = 'logrow';
      d.innerHTML = `<b>${esc(m.from)} → ${esc(m.to)}</b><span>${esc(m.why)} · tempo ${esc(m.tempo)}${m.phaseAtSwitch ? ' · beat error ' + esc(m.phaseAtSwitch) : ''}</span>${m.picked ? `<span>Picked because: ${esc(m.picked)}</span>` : ''}`;
      box.appendChild(d);
    }
  }

  /* ---------- UI: controls ---------- */
  function setMode(m) {
    S.mode = m; saveSettings();
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    S.rejected.clear(); S.energyAuto = true; updateEnergyUI();
    S.themeInit = null;
    if (S.started) { purgeCrate(); ensurePool().then(() => { rethinkNext(); fillCrate(); }); }
    else renderIdeas();
  }
  function setLang(l) {
    S.lang = l; saveSettings();
    document.querySelectorAll('#langs button').forEach(b => b.classList.toggle('on', b.dataset.lang === l));
    S.rejected.clear(); S.langBlock = null;
    if (S.started) { purgeCrate(); ensurePool().then(() => { rethinkNext(); fillCrate(); }); }
    else renderIdeas();
  }
  function updateEnergyUI() {
    const v = energyTarget();
    if (S.energyAuto) $('#energy').value = v;
    $('#energyVal').textContent = Math.round(v * 100) + (S.energyAuto ? ' · auto' : '');
    $('#energyAuto').style.display = S.energyAuto ? 'none' : '';
  }

  document.querySelectorAll('#modes button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll('#langs button').forEach(b => b.onclick = () => setLang(b.dataset.lang));
  $('#energy').oninput = e => { S.energyAuto = false; S.energyManual = +e.target.value; updateEnergyUI(); };
  $('#energy').onchange = () => { renderIdeas(); };
  $('#energyAuto').onclick = () => { S.energyAuto = true; updateEnergyUI(); renderIdeas(); };
  $('#volume').value = S.volume;
  $('#volume').oninput = e => { S.volume = +e.target.value; if (mixer) mixer.setVolume(S.volume); saveSettings(); };
  $('#start').onclick = () => start().catch(err => { console.error(err); status('Something went wrong: ' + err.message); S.started = false; $('#start').disabled = false; });
  $('#pause').onclick = async () => { const p = await mixer.togglePause(); $('#pause').textContent = p ? '▶ Resume' : '⏸ Pause'; };
  $('#mixnow').onclick = () => mixNow(false);

  /* ---------- phone app bits ---------- */
  // installable app + instant start (the service worker only caches Boonbeat's own files)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* still works as a normal page */ });
  }
  // keep the phone screen awake while the party is on, so the mixing never gets paused by the screen lock
  let wakeLock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || !S.started || document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed right now */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
  // lock screen / notification / headphone controls
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* not supported */ } };
    set('play', () => { if (mixer && mixer.paused) $('#pause').click(); });
    set('pause', () => { if (mixer && !mixer.paused) $('#pause').click(); });
    set('nexttrack', () => { if (mixer) mixNow(true); });
  }
  function showOnLockScreen(t) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: 'Boonbeat',
      artwork: t.artwork ? [{ src: t.artwork, sizes: '480x480' }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  $('#skip').onclick = () => mixNow(true);
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space' && mixer) { e.preventDefault(); $('#pause').click(); }
    if (e.key === 'n' || e.key === 'N') mixNow(false);
    if (e.key === 'ArrowRight') { e.preventDefault(); jumpBars(8); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); jumpBars(-8); }
  });

  $('#reqForm').onsubmit = async e => {
    e.preventDefault();
    const q = $('#reqQ').value.trim();
    if (!q) return;
    $('#reqResults').innerHTML = '<div class="hint">Searching…</div>';
    try {
      const list = await Src.searchAll(q);
      addToPool(list);
      const shown = list.map(t => S.pool.get(t.id));
      $('#reqResults').innerHTML = shown.length ? '' : '<div class="hint">Nothing playable found.</div>';
      for (const t of shown.slice(0, 15)) $('#reqResults').appendChild(row(t, [['Play next', () => request(t)]]));
    } catch (err) { $('#reqResults').innerHTML = '<div class="hint">Search failed: ' + esc(err.message) + '</div>'; }
  };

  function request(t) {
    S.requests.unshift(t);
    status(`Requested “${t.title}”, it plays next.`);
    if (S.started && !mixer.tx) { S.next = null; mixer.schedule(null); preloadNext(); }
    else renderNext();
  }

  $('#files').onchange = async e => {
    const files = [...e.target.files];
    const list = [];
    for (const f of files) list.push(await Src.fromFile(f));
    addToPool(list);
    $('#localInfo').textContent = `${[...S.pool.values()].filter(t => t.src === 'local').length} of your own songs added.`;
    renderIdeas();
  };

  /* ---------- taste: 👍 / 👎 ---------- */
  const rated = t => (window.DJTaste ? window.DJTaste.rating(t) : 0);
  function thumbUp(t) {
    if (rated(t) > 0) { window.DJTaste.clear(t); status(`Okay, forgot your 👍 for “${t.title}”.`); }
    else { window.DJTaste.like(t, B.detectLanguage(t)); status(`👍 Noted: more like “${t.title}”${t.artist ? ' and ' + t.artist : ''}.`); }
    renderAll();
  }
  function thumbDown(t) {
    if (rated(t) < 0) { window.DJTaste.clear(t); status(`Okay, “${t.title}” can play again.`); renderAll(); return; }
    window.DJTaste.dislike(t, B.detectLanguage(t));
    S.crate.delete(t.id);
    S.requests = S.requests.filter(r => r.id !== t.id);
    if (mixer && mixer.current.track === t && !mixer.tx) { mixNow(true); status(`👎 Got it, skipping “${t.title}” and steering away from songs like it.`); }
    else if (S.next === t) { status(`👎 Got it, picking something else instead of “${t.title}”.`); rethinkNext(); }
    else status(`👎 Noted: no more “${t.title}”, and fewer songs like it.`);
    renderAll();
  }
  function renderTaste() {
    const el = $('#tasteInfo'); if (!el || !window.DJTaste) return;
    const { likes, bans } = window.DJTaste.summary();
    el.innerHTML = likes + bans ? `Learning your taste: ${likes} 👍 · ${bans} 👎 <button class="link" id="tasteReset">reset</button>` : 'Tap 👍 or 👎 on any song and the DJ learns what you like.';
    const b = $('#tasteReset');
    if (b) b.onclick = () => { if (confirm('Forget all your 👍 and 👎?')) { window.DJTaste.reset(); renderAll(); } };
  }

  /* ---------- your favourite songs ---------- */
  function favFound() {
    const F = window.DJFav; if (!F) return { have: 0, found: 0 };
    const hit = new Set();
    for (const t of S.pool.values()) { const f = F.match(t); if (f) hit.add(f.title); }
    return { have: F.list().length, found: hit.size };
  }
  function renderFav() {
    const F = window.DJFav, box = $('#favText'), info = $('#favInfo');
    if (!F || !box) return;
    if (document.activeElement !== box) box.value = F.asText();
    const { have, found } = favFound();
    info.textContent = S.pool.size
      ? `${have} favourites · ${found} found on the free sources so far. Boonbeat plays them first and learns your taste from them.`
      : `${have} favourites. Boonbeat searches for these first, plays them with priority and learns your taste from them.`;
  }
  function favChanged() {
    for (const k of [...S.fetched]) if (k.startsWith('s:') || k.startsWith('a:')) S.fetched.delete(k);
    renderFav();
    if (S.started) ensurePool().then(() => { renderFav(); fillCrate(); renderIdeas(); });
  }
  if ($('#favSave')) {
    $('#favSave').onclick = () => { window.DJFav.setFromText($('#favText').value); status('Favourites saved. Boonbeat will look for them.'); favChanged(); };
    $('#favReset').onclick = () => { window.DJFav.reset(); status('Back to your original favourites list.'); favChanged(); };
  }

  /* ---------- UI: rendering ---------- */
  const LANG_CYCLE = ['hindi', 'punjabi', 'english'];
  const MOOD_CYCLE = ['dance', 'romantic', 'chill'];
  function override(t, key, cycle) {
    const curVal = key === 'lang' ? B.detectLanguage(t) : B.moodOf(t);
    const nv = cycle[(cycle.indexOf(curVal) + 1) % cycle.length];
    if (key === 'lang') t.langManual = nv; else t.moodManual = nv;
    overrides[t.id] = Object.assign(overrides[t.id] || {}, { [key]: nv });
    LS.set('over', overrides);
    renderAll();
  }
  function chips(t, opts = {}) {
    const wrap = document.createElement('div'); wrap.className = 'chips';
    const lang = B.detectLanguage(t), mood = B.moodOf(t);
    const c1 = document.createElement('span'); c1.className = `chip click lang-${lang}`; c1.textContent = lang; c1.title = 'Click to correct the language';
    c1.onclick = ev => { ev.stopPropagation(); override(t, 'lang', LANG_CYCLE); };
    const c2 = document.createElement('span'); c2.className = `chip click mood-${mood}`; c2.textContent = mood; c2.title = 'Click to correct the mood';
    c2.onclick = ev => { ev.stopPropagation(); override(t, 'mood', MOOD_CYCLE); };
    wrap.append(c1, c2);
    const bpm = B.bpmOf(t);
    if (bpm) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = Math.round(bpm) + ' BPM' + (opts.rate && Math.abs(opts.rate - 1) > 0.002 ? ` (${opts.rate > 1 ? '+' : ''}${((opts.rate - 1) * 100).toFixed(1)}%)` : ''); wrap.append(c); }
    const cam = B.camelot(B.keyOf(t));
    if (cam) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = cam.n + cam.l; c.title = B.keyOf(t) + (t.key ? '' : ' (detected)'); wrap.append(c); }
    if (t.src === 'local') { const c = document.createElement('span'); c.className = 'chip'; c.textContent = 'your file'; wrap.append(c); }
    if (t.ml) {
      const c = document.createElement('span'); c.className = 'chip'; c.textContent = `party ${Math.round(t.ml.party * 100)}%`; c.title = 'AI party-mood score (Essentia MusiCNN)'; wrap.append(c);
      const v = document.createElement('span'); v.className = 'chip'; v.textContent = `vocals ${Math.round(t.ml.vocalShare * 100)}%`; v.title = 'share of the song with singing (AI)'; wrap.append(v);
    }
    return wrap;
  }
  function row(t, actions = [], dim) {
    const r = document.createElement('div'); r.className = 'row' + (dim ? ' dim' : '');
    r.innerHTML = `<div class="art" style="background-image:url('${esc(t.artwork)}')"></div><div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}${t.duration ? ' · ' + fmt(t.duration) : ''}</div></div>`;
    r.querySelector('.meta').appendChild(chips(t));
    for (const [label, fn] of actions) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; r.appendChild(b); }
    return r;
  }

  const deckCanvases = [];
  function renderDeck(i) {
    const el = $('#deck' + i);
    const d = mixer && mixer.decks[i];
    const t = d && d.track;
    if (!t) { el.innerHTML = `<div class="empty">Deck ${'AB'[i]}</div>`; el.classList.remove('live'); deckCanvases[i] = null; return; }
    el.innerHTML = `<div class="head"><div class="art" style="background-image:url('${esc(t.artwork)}')"></div>
      <div class="meta"><div class="name">${esc(t.title)}</div><div class="artist">${t.link ? `<a href="${esc(t.link)}" target="_blank" rel="noopener">${esc(t.artist)}</a>` : esc(t.artist)}</div></div>
      <span class="badge">${'AB'[i]} · <span class="st"></span></span>
      <span class="thumbs"><button class="thumb up${rated(t) > 0 ? ' on' : ''}" title="More like this">👍</button><button class="thumb down${rated(t) < 0 ? ' on' : ''}" title="Never play this again">👎</button></span></div>
      <div class="chipslot"></div><div class="ebar"><i style="width:${Math.round(B.energyOf(t) * 100)}%"></i></div>
      <canvas width="800" height="140"></canvas><div class="times"><span class="el"></span><span class="rm"></span></div>
      <div class="legend"><span><i style="background:#ff3d9a88"></i>drop/chorus</span><span><i style="background:#29e3ff55"></i>breakdown</span><span><i style="background:#ff3d9a"></i>mix starts</span><span><i style="background:#b6ff3d"></i>switch / drop</span></div>`;
    el.querySelector('.chipslot').appendChild(chips(t, { rate: d.rate }));
    el.querySelector('.thumb.up').onclick = () => thumbUp(t);
    el.querySelector('.thumb.down').onclick = () => thumbDown(t);
    deckCanvases[i] = el.querySelector('canvas');
    // click / drag on the playing deck's waveform to jump there
    const cv = deckCanvases[i];
    cv.title = 'Click to jump here (← / → jump 8 bars)';
    const timeAt = ev => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (t.a ? t.a.duration : t.duration); };
    cv.onclick = ev => {
      if (!mixer || mixer.cur !== i) { status('That song is cued: it comes in on its own at the planned mix point.'); return; }
      seekTo(timeAt(ev));
    };
    cv.onmousemove = ev => { cv.style.cursor = mixer && mixer.cur === i && !mixer.tx ? 'pointer' : 'default'; cv.dataset.hover = timeAt(ev); };
    cv.onmouseleave = () => { delete cv.dataset.hover; };
  }

  function drawDeck(i) {
    const cv = deckCanvases[i];
    const d = mixer.decks[i], t = d.track;
    const el = $('#deck' + i);
    const live = mixer.cur === i;
    el.classList.toggle('live', live);
    const st = el.querySelector('.st');
    if (st) st.textContent = live ? 'LIVE' : (mixer.tx ? 'MIXING IN' : (S.next === t ? 'CUED' : 'IDLE'));
    if (!cv || !t || !t.a) return;
    const a = t.a, g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const dur = a.duration, pos = d.time;
    g.clearRect(0, 0, W, H);
    // song sections: drops/choruses pink, breakdowns blue, intro/outro grey
    if (a.sections) {
      const col = { drop: '#ff3d9a2e', break: '#29e3ff1f', intro: '#ffffff0d', outro: '#ffffff0d' };
      for (const s of a.sections) {
        g.fillStyle = col[s.type] || '#ffffff08';
        g.fillRect((s.t0 / dur) * W, 0, ((s.t1 - s.t0) / dur) * W, H);
        g.fillStyle = '#ffffff30'; g.fillRect((s.t0 / dur) * W, 0, 1, H);
      }
    } else {
      g.fillStyle = '#ffffff08';
      g.fillRect(0, 0, (a.introEnd / dur) * W, H);
      g.fillRect((a.outroStart / dur) * W, 0, W, H);
    }
    const n = a.peaks.length, bw = W / n;
    for (let k = 0; k < n; k++) {
      const x = k * bw, v = a.peaks[k] / 255, h = Math.max(1, v * (H - 10));
      g.fillStyle = (k / n) * dur < pos ? (live ? '#29e3ff' : '#8f8eb0') : '#3b3b5c';
      g.fillRect(x, (H - h) / 2, Math.max(1, bw - 0.6), h);
    }
    // cue points: on the live deck where the blend starts (pink) and the switch bar (green);
    // on the cued deck where it comes in (pink) and its drop (green)
    const plan = mixer.plan || mixer.tx;
    const mark = (t, c, w) => { if (t == null) return; g.fillStyle = c; g.fillRect((t / dur) * W - w / 2, 0, w, H); };
    if (plan && live) { mark(plan.startTime, '#ff3d9a', 3); mark(plan.switchTime, '#b6ff3d', 4); }
    if (plan && !live && S.next === t) { mark(plan.cueIn, '#ff3d9a', 3); mark(plan.dropIn, '#b6ff3d', 4); }
    g.fillStyle = '#fff'; g.fillRect((pos / dur) * W - 1, 0, 2, H);
    if (live && cv.dataset.hover && !mixer.tx) {
      const hx = (+cv.dataset.hover / dur) * W;
      g.fillStyle = '#ffffff55'; g.fillRect(hx - 1, 0, 2, H);
      g.fillStyle = '#fff'; g.font = '22px system-ui'; g.fillText(fmt(+cv.dataset.hover), Math.min(W - 60, hx + 6), 24);
    }
    el.querySelector('.el').textContent = fmt(pos);
    el.querySelector('.rm').textContent = '-' + fmt(dur - pos);
  }

  function renderNext() {
    const box = $('#next'); box.innerHTML = '';
    if (S.next) {
      const el = row(S.next, [['Mix now', () => mixNow(false)], ['Not now', () => { S.rejected.add(S.next.id); rethinkNext(); }], ['👎', () => thumbDown(S.next)]]);
      if (S.next.pickWhy) { const w = document.createElement('div'); w.className = 's'; w.textContent = 'Why: ' + S.next.pickWhy; el.querySelector('.meta').appendChild(w); }
      box.appendChild(el);
    }
    else if (S.loadingNext) box.innerHTML = '<div class="hint">Choosing and analysing the next song…</div>';
    else if (!S.started) box.innerHTML = '<div class="hint">Hit Start and the DJ takes over.</div>';
    for (const r of S.requests) box.appendChild(row(r, [['Remove', () => { S.requests = S.requests.filter(x => x !== r); renderNext(); }]], true));
  }

  function renderIdeas() {
    const box = $('#ideas'); box.innerHTML = '';
    if (S.started && S.crate.size) {
      const cur = mixer && mixer.current.track, ctx = ctxFor(cur);
      const sim = cur && cur.a && cur.a.beatSync ? { curBar: mixer.current.beatPos(mixer.current.time) / 4, playStart: mixer.playStart } : null;
      const list = [...S.crate.values()].map(c => ({ t: c.track, r: cur && sim ? B.transitionScore(c.track, ctx, sim) : B.scoreDetail(c.track, ctx) }))
        .filter(x => x.r).sort((a, b) => b.r.total - a.r.total);
      for (const { t, r } of list) {
        const el = row(t, [['Play next', () => request(t)]], true);
        const why = document.createElement('div'); why.className = 's'; why.textContent = `score ${r.total.toFixed(2)}: ${reasonText(r.parts)}`;
        el.querySelector('.meta').appendChild(why);
        box.appendChild(el);
      }
      if (S.filling) box.insertAdjacentHTML('beforeend', '<div class="hint">Pulling another record…</div>');
      return;
    }
    const ex = new Set([...(S.next ? [S.next.id] : []), ...S.rejected]);
    const list = B.rankList([...S.pool.values()].filter(t => !ex.has(t.id)), ctxFor(mixer && mixer.current.track), 5);
    if (!list.length) { box.innerHTML = `<div class="hint">${S.pool.size ? 'Nothing matches yet.' : 'Songs show up here once the DJ starts looking.'}</div>`; return; }
    for (const t of list) box.appendChild(row(t, [['Play next', () => request(t)]], true));
  }

  function renderHistory() {
    const box = $('#history'); box.innerHTML = '';
    for (const t of S.history.slice().reverse().slice(0, 30)) {
      const r = row(t, [[rated(t) > 0 ? '👍 liked' : '👍', () => thumbUp(t)], [rated(t) < 0 ? '👎 never' : '👎', () => thumbDown(t)]], t !== S.history[S.history.length - 1]);
      box.appendChild(r);
    }
    renderTaste();
    const cv = $('#setGraph'); const g = cv.getContext('2d');
    cv.width = cv.clientWidth * devicePixelRatio; cv.height = 70 * devicePixelRatio;
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const pts = S.history.map(t => B.energyOf(t));
    if (pts.length < 1) return;
    g.strokeStyle = '#ff3d9a'; g.lineWidth = 2 * devicePixelRatio; g.beginPath();
    pts.forEach((v, k) => { const x = pts.length === 1 ? W / 2 : (k / (pts.length - 1)) * (W - 10) + 5; const y = H - 5 - v * (H - 10); k ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.fillStyle = '#8f8eb0'; g.font = `${10 * devicePixelRatio}px system-ui`; g.fillText('energy', 4, 12 * devicePixelRatio);
  }

  function renderAll() { renderDeck(0); renderDeck(1); renderNext(); renderIdeas(); renderHistory(); renderFav(); }

  // animation loop
  function frame() {
    if (mixer) {
      drawDeck(0); drawDeck(1);
      for (let i = 0; i < 2; i++) $('#m' + i).style.height = Math.round(mixer.decks[i].gain.gain.value * 100) + '%';
      const p = mixer.tx || mixer.plan;
      if (mixer.tx) {
        $('#txLabel').textContent = 'Mixing: ' + mixer.tx.label;
        $('#txProg').style.width = Math.round(Math.max(0, mixer.tx.progress || 0) * 100) + '%';
        $('#txInfo').textContent = mixer.tx.type === 'beat' ? `phase ${Math.round(mixer.lastPhaseErr)} ms${mixer.tx.swapped ? ' · bass swapped' : ''}` : '';
      } else if (p) {
        const left = (p.startTime - mixer.current.time) / mixer.current.rate;
        $('#txLabel').textContent = `Next: ${p.label}`;
        $('#txProg').style.width = '0%';
        $('#txInfo').textContent = `in ${fmt(left)}`;
      } else { $('#txLabel').textContent = S.loadingNext ? 'Picking next…' : '—'; $('#txInfo').textContent = ''; $('#txProg').style.width = '0%'; }
      if (!mixer.tx && Math.random() < 0.02) updateEnergyUI();
    }
    requestAnimationFrame(frame);
  }

  // init
  setMode(S.mode); setLang(S.lang); updateEnergyUI(); renderAll(); frame();
  window.DJ = { S, B, Src, get mixer() { return mixer; }, set mixer(m) { mixer = m; }, addToPool, request, renderAll, start };
})();
