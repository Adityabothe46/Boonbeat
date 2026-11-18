/* Taste memory: learns from 👍 / 👎 across nights.
   Stores a small fingerprint per rated song (artist, genre, language, sound style, AI scores, tempo)
   and scores new songs by how close they are to what you liked vs. disliked. Saved in localStorage. */
(function (root) {
  'use strict';
  const KEY = 'aidj.taste';
  let T = { likes: {}, bans: {} };
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && v.likes && v.bans) T = v; } catch (e) { /* fresh */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch (e) { /* ignore */ } };
  const lc = s => (s || '').toLowerCase().trim();

  // compact, comparable fingerprint (all roughly 0..1 scale)
  function features(t) {
    const a = t.a, m = t.ml;
    if (!a || !a.style) return null;
    const f = a.style.slice(0, 4).map(v => (v + 20) / 20);       // spectral balance, dB relative -> ~0..1
    f.push(Math.min(1, a.style[4] / 8));                          // drum density
    f.push(m ? m.party : 0.5, m ? m.dance : 0.5, m ? m.vocalShare : 0.5);
    f.push(Math.min(1.3, a.bpm / 150));
    return f.map(v => Math.round(v * 1000) / 1000);
  }

  function snapshot(t, lang) {
    return { title: t.title, artist: lc(t.artist), genre: lc(t.genre), lang, f: features(t), at: Date.now() };
  }

  function like(t, lang) { delete T.bans[t.id]; T.likes[t.id] = snapshot(t, lang); save(); }
  function dislike(t, lang) { delete T.likes[t.id]; T.bans[t.id] = snapshot(t, lang); save(); }
  function clear(t) { delete T.likes[t.id]; delete T.bans[t.id]; save(); }
  function reset() { T = { likes: {}, bans: {} }; save(); }
  const rating = t => (T.likes[t.id] ? 1 : T.bans[t.id] ? -1 : 0);
  const isBanned = id => !!T.bans[id];

  function centroid(list) {
    const fs = list.map(x => x.f).filter(Boolean);
    if (!fs.length) return null;
    return fs[0].map((_, i) => fs.reduce((s, f) => s + f[i], 0) / fs.length);
  }
  const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) * (v - b[i]), 0));

  // returns { ban: true } or { parts: { reason: value } }
  function score(t) {
    if (T.bans[t.id]) return { ban: true };
    const parts = {};
    const add = (k, v) => { if (Math.abs(v) >= 0.01) parts[k] = Math.round(((parts[k] || 0) + v) * 100) / 100; };
    if (T.likes[t.id]) add('you liked it', 0.8);
    const likes = Object.values(T.likes), bans = Object.values(T.bans);
    const artist = lc(t.artist), genre = lc(t.genre);
    if (artist && artist !== 'unknown') {
      const la = likes.filter(x => x.artist === artist).length, ba = bans.filter(x => x.artist === artist).length;
      if (la) add('artist you like', Math.min(0.6, 0.3 * la));
      if (ba) add('artist you skipped', -Math.min(0.9, 0.45 * ba));
    }
    if (genre) {
      const net = likes.filter(x => x.genre === genre).length - bans.filter(x => x.genre === genre).length;
      if (net) add(net > 0 ? 'genre you like' : 'genre you skip', Math.max(-0.45, Math.min(0.45, 0.15 * net)));
    }
    // sounds like the songs you liked (needs the song to be analysed)
    const f = features(t);
    if (f) {
      const cl = likes.length >= 2 ? centroid(likes) : null, cb = bans.length >= 2 ? centroid(bans) : null;
      const sim = c => Math.exp(-dist(f, c) / 0.35);
      if (cl) add('sounds like your likes', 0.8 * sim(cl));
      if (cb) add('sounds like your skips', -0.8 * sim(cb));
    }
    return { parts };
  }

  function summary() { return { likes: Object.keys(T.likes).length, bans: Object.keys(T.bans).length }; }

  root.DJTaste = { like, dislike, clear, reset, rating, isBanned, score, summary, features, _data: () => T };
})(window);
