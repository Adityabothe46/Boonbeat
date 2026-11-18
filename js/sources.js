/* Music sources: Audius, hearthis.at and Internet Archive netlabels (all free, full tracks the browser may analyse), plus your own files. */
(function (root) {
  'use strict';

  const API = 'https://api.audius.co/v1';
  const APP = 'Boonbeat';

  const BAD_GENRES = ['podcasts', 'audiobooks', 'spoken word', 'comedy', 'kids', 'devotional'];
  const BAD_WORDS = /\b(demo|snippet|preview|sample pack|podcast|episode|full album|jukebox|nonstop|non-stop|non stop|1 hour|one hour|dj set|live set|mixtape|radio show|tutorial|type beat|beat tape|free beat|draft|wip|unmastered|teaser|ringtone|whatsapp status|status video)\b/i;
  // SEO spam / rip-site uploads (seen in the Audius audit): mp3 download sites, tiktok-viral spam, ___underscored___ filenames, raw .wav bounces
  const SPAM = /(mp3\s*ind[iı]r|mp3indir|guncelmp3|\bterbaru\b|\(wav\)|\(offical|mp3cut)/i;
  // AI-generated tracks ("(IA) King Miaou", Suno/Udio/Mureka songs): not real songs, keep them out
  const AI_MADE = /(\((ia|ai)\)|\[(ia|ai)\]|\bai[\s-]*(generated|song|music|cover|version|made)\b|\b(suno|udio|mureka|boomy|soundraw|aiva)\b|created (with|by) ai|cr[ée]ation\s+mureka)/i;
  const isAiMade = (title, desc, tags) => AI_MADE.test(`${title || ''} ${desc || ''} ${tags || ''}`);

  // "Bollywood-Remix-Song-Love" / "Excuse_Me_Girl" -> readable titles
  function tidyTitle(t) {
    let s = (t || '').trim();
    const seps = (s.match(/[_-]/g) || []).length, spaces = (s.match(/ /g) || []).length;
    if (seps >= 2 && spaces <= 1) s = s.replace(/_+/g, ' ').replace(/-+/g, ' ').replace(/\s+/g, ' ');
    // strip rip-site and quality noise: "320 Kbps", "(Mr-Jatt.com)", "(Official Audio)", ".mp3", "Lyrics"
    s = s.replace(/\(?\b(pagalworld|mr-?jatt|djpunjab|wapking|djmaza|songspk|mp3mad)\b[^)]*\)?/ig, ' ')
      .replace(/[\(\[]?\s*[\w-]+\.(com|net|in|pk|io|co|info)\s*[\)\]]?/ig, ' ')
      .replace(/\b(128|192|256|320)\s*kbps\b/ig, ' ').replace(/\.mp3\b/ig, ' ')
      .replace(/[\(\[]\s*(official\s*(audio|video|music video|lyric(al)? video)?|lyrics?|full (song|video)|hd|hq|audio)\s*[\)\]]/ig, ' ')
      .replace(/\s*[|►]\s*$/g, '');
    return s.replace(/_+/g, ' ').replace(/\(\s*\)/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // retry on rate limits and flaky servers
  async function fetchRetry(url, tries = 3) {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(url);
        if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(800 * (i + 1) * (r.status === 429 ? 2 : 1)); continue; }
        return r;
      } catch (e) {
        if (i >= tries - 1) throw e;
        await sleep(800 * (i + 1));
      }
    }
  }

  // Audius answers 429 when asked too fast (a set start fires dozens of searches): one call at a time, ~0.3 s apart
  let audiusGate = Promise.resolve();
  function audiusTurn() {
    const turn = audiusGate.then(() => sleep(200));
    audiusGate = turn;
    return turn;
  }
  async function getJSON(url) {
    await audiusTurn();
    const r = await fetchRetry(url, 4);
    if (!r.ok) throw new Error('Audius ' + r.status);
    const j = await r.json();
    return j.data || [];
  }

  function normalizeAudius(t) {
    const art = t.artwork || {};
    return {
      id: 'au:' + t.id,
      src: 'audius',
      audiusId: t.id,
      title: tidyTitle(t.title),
      artist: (t.user && t.user.name) || 'Unknown',
      artwork: art['480x480'] || art['150x150'] || '',
      // the same image on Audius' backup servers (some servers fail in Chrome)
      artAlts: (() => {
        const main = art['480x480'] || art['150x150'] || '';
        const m = main.match(/^https?:\/\/[^/]+(\/.*)$/);
        return m && Array.isArray(art.mirrors) ? art.mirrors.map(h => h.replace(/\/$/, '') + m[1]) : [];
      })(),
      genre: t.genre || '',
      mood: t.mood || '',
      tags: (t.tags || '').toLowerCase(),
      description: (t.description || '').slice(0, 400),
      duration: t.duration || 0,
      plays: t.play_count || 0,
      favs: t.favorite_count || 0,
      reposts: t.repost_count || 0,
      remixOf: !!(t.remix_of && t.remix_of.tracks && t.remix_of.tracks.length),
      metaBpm: t.bpm || null,
      key: t.musical_key || null,
      verified: !!(t.user && t.user.is_verified),
      // uploaded by the artist's or label's own verified account: an official release, not someone's re-upload
      official: !!(t.user && t.user.is_verified),
      followers: (t.user && t.user.follower_count) || 0,
      link: 'https://audius.co' + (t.permalink || ''),
      url: `${API}/tracks/${t.id}/stream?app_name=${APP}`,
    };
  }

  function usable(t, raw) {
    if (raw.is_streamable === false || raw.is_stream_gated || raw.stream_conditions) return false;
    if (raw.is_delete || raw.is_unlisted || raw.is_available === false) return false;
    if (raw.access && raw.access.stream === false) return false;
    if (t.duration < 90 || t.duration > 480) return false;
    if (BAD_GENRES.includes(t.genre.toLowerCase())) return false;
    if (BAD_WORDS.test(t.title) || SPAM.test(raw.title || '')) return false;
    if (raw.ai_attribution_user_id || isAiMade(raw.title, raw.description, raw.tags)) return false;
    // Quality bar: skip bot-farmed uploads (no audio analysis, unverified, generic)
    if (!t.metaBpm && !t.verified) return false;
    if (t.plays < 150 && !t.verified) return false;
    return true;
  }

  /* ---------- official artist and label accounts on Audius ----------
     Verified accounts (Disclosure, Dirtybird, Anjunadeep, Black Hole Recordings...) post their own releases:
     the real originals, full length, free to stream. 'handle' is the account name in the audius.co link. */
  // account ids never change: remember them so the next set skips the lookups
  const userIds = new Map(Object.entries((() => { try { return JSON.parse(localStorage.getItem('aidj.audiusIds') || '{}'); } catch (e) { return {}; } })()));
  async function audiusUser(handle, pages = 1) {
    let id = userIds.get(handle);
    if (!id) {
      await audiusTurn();
      const r = await fetchRetry(`${API}/users/handle/${encodeURIComponent(handle)}?app_name=${APP}`, 4);
      if (!r.ok) return [];
      const u = (await r.json()).data;
      if (!u || !u.is_verified) return [];
      id = u.id; userIds.set(handle, id);
      try { localStorage.setItem('aidj.audiusIds', JSON.stringify(Object.fromEntries(userIds))); } catch (e) { /* ignore */ }
    }
    const out = [];
    for (let p = 0; p < pages; p++) {
      const data = await getJSON(`${API}/users/${id}/tracks?limit=100&offset=${p * 100}&sort_method=plays&sort_direction=desc&app_name=${APP}`);
      for (const raw of data) { const t = normalizeAudius(raw); if (usable(t, raw)) out.push(t); }
      if (data.length < 100) break;
    }
    return out;
  }

  async function search(query, limit = 40) {
    const data = await getJSON(`${API}/tracks/search?query=${encodeURIComponent(query)}&limit=${limit}&app_name=${APP}`);
    return data.map(raw => [normalizeAudius(raw), raw]).filter(([t, raw]) => usable(t, raw)).map(([t]) => t);
  }

  // two pages of Audius results for artist searches (more songs per artist)
  async function searchAudius(query, limit = 40, offset = 0) {
    const data = await getJSON(`${API}/tracks/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&app_name=${APP}`);
    return data.map(raw => [normalizeAudius(raw), raw]).filter(([t, raw]) => usable(t, raw)).map(([t]) => t);
  }

  /* ---------- hearthis.at (free, open API, full tracks with BPM + key tags) ---------- */
  const HT = 'https://api-v2.hearthis.at';
  function normalizeHearthis(t) {
    const u = t.user || {};
    const bpm = parseFloat(t.bpm);
    return {
      id: 'ht:' + t.id,
      src: 'hearthis',
      title: tidyTitle(t.title),
      artist: u.username || 'Unknown',
      taggedArtists: Array.isArray(t.taged_artists_arr) ? t.taged_artists_arr.map(a => (a && (a.username || a.permalink)) || String(a)) : [],
      artwork: t.artwork_url || t.thumb || '',
      genre: t.genre || '',
      mood: '',
      tags: ((t.tags || '') + ' ' + (t.genre_slush || '')).toLowerCase(),
      description: (t.description || '').slice(0, 400),
      duration: parseInt(t.duration, 10) || 0,
      plays: parseInt(t.playback_count, 10) || 0,
      favs: parseInt(t.favoritings_count, 10) || 0,
      reposts: parseInt(t.reshares_count, 10) || 0,
      metaBpm: bpm > 50 && bpm < 200 ? bpm : null,
      key: t.key || null,
      verified: false,
      link: t.permalink_url || '',
      // hearthis.app redirects to hearthis.at without CORS headers, which the browser refuses: go straight to .at
      url: (t.stream_url || '').replace(/^https?:\/\/(www\.)?hearthis\.app\//, 'https://hearthis.at/'),
    };
  }
  function usableHearthis(t, raw) {
    if (!t.url || raw.private === '1' || raw.fan_exclusive_play === '1' || raw.is_live === '1') return false;
    if (t.duration < 90 || t.duration > 480) return false;   // DJ mixes and live sets are hours long
    if (BAD_GENRES.includes(t.genre.toLowerCase())) return false;
    if (BAD_WORDS.test(t.title) || SPAM.test(raw.title || '')) return false;
    if (isAiMade(raw.title, raw.description, raw.tags)) return false;
    if (t.plays < 60) return false;
    return true;
  }
  async function htJSON(url) {
    const r = await fetchRetry(url);
    if (!r.ok) throw new Error('hearthis ' + r.status);
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  }
  async function searchHearthis(query, count = 40) {
    const d = await htJSON(`${HT}/search/?t=${encodeURIComponent(query)}&page=1&count=${count}`);
    return d.map(raw => [normalizeHearthis(raw), raw]).filter(([t, raw]) => usableHearthis(t, raw)).map(([t]) => t);
  }
  // a genre feed (bollywood, indian, house, deephouse, edm, pop, hiphop, lofi...): first pages, songs only
  async function hearthisGenre(slug, pages = 3) {
    const out = [];
    for (let p = 1; p <= pages; p++) {
      let d = [];
      try { d = await htJSON(`${HT}/categories/${encodeURIComponent(slug)}/?page=${p}&count=40`); } catch (e) { break; }
      if (!d.length) break;
      for (const raw of d) { const t = normalizeHearthis(raw); if (usableHearthis(t, raw)) out.push(t); }
    }
    return out;
  }

  /* ---------- Internet Archive netlabels (Creative Commons releases, free to stream) ---------- */
  const IA = 'https://archive.org';
  async function archive(subject, items = 12) {
    const q = `collection:netlabels AND mediatype:audio AND subject:(${subject}) AND licenseurl:*creativecommons*`;
    const u = `${IA}/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&fl[]=subject&sort[]=downloads+desc&rows=${items}&output=json`;
    const r = await fetchRetry(u);
    if (!r.ok) throw new Error('archive ' + r.status);
    const docs = ((await r.json()).response || {}).docs || [];
    const out = [];
    let i = 0;
    const worker = async () => {
      while (i < docs.length) {
        const doc = docs[i++];
        try {
          const m = await (await fetchRetry(`${IA}/metadata/${encodeURIComponent(doc.identifier)}`)).json();
          const files = (m.files || []).filter(f => /\.mp3$/i.test(f.name) && (f.source === 'original' || /mp3/i.test(f.format || '')));
          const seen = new Set();
          for (const f of files) {
            const len = parseFloat(f.length) || 0;
            if (len < 120 || len > 480) continue;
            const title = tidyTitle(f.title || f.name.replace(/\.mp3$/i, '').replace(/^\d+[\s._-]*/, ''));
            if (seen.has(title.toLowerCase()) || BAD_WORDS.test(title)) continue;
            seen.add(title.toLowerCase());
            const subj = Array.isArray(doc.subject) ? doc.subject.join(' ') : (doc.subject || '');
            out.push({
              id: 'ia:' + doc.identifier + '/' + f.name, src: 'archive',
              title, artist: f.creator || f.artist || (Array.isArray(doc.creator) ? doc.creator[0] : doc.creator) || 'Unknown',
              artwork: `${IA}/services/img/${encodeURIComponent(doc.identifier)}`,
              genre: subject, mood: '', tags: subj.toLowerCase(), description: '',
              duration: len, plays: Math.round((doc.downloads || 0) / Math.max(1, files.length)), favs: 0, reposts: 0,
              metaBpm: null, key: null, verified: true, license: (m.metadata && m.metadata.licenseurl) || '',
              link: `${IA}/details/${encodeURIComponent(doc.identifier)}`,
              url: `${IA}/download/${encodeURIComponent(doc.identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
            });
          }
        } catch (e) { /* skip this release */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }

  // artist search across Audius (two pages) and hearthis; keep only tracks that actually *credit* the artist
  // (so a search for DIVINE doesn't bring in "Divine Frequency")
  async function searchArtist(name) {
    const lists = await Promise.allSettled([searchAudius(name, 40, 0), searchAudius(name, 40, 40), searchHearthis(name, 40)]);
    const all = lists.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    const B = root.DJBrain;
    return B && B.credited ? all.filter(t => B.credited(t, name)) : all;
  }
  // free-text search (requests): every source at once
  async function searchAll(query) {
    const lists = await Promise.allSettled([search(query, 30), searchHearthis(query, 30)]);
    return lists.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  }

  async function trending(genre, time = 'month') {
    const g = genre ? `&genre=${encodeURIComponent(genre)}` : '';
    const data = await getJSON(`${API}/tracks/trending?time=${time}${g}&app_name=${APP}`);
    return data.map(raw => [normalizeAudius(raw), raw]).filter(([t, raw]) => usable(t, raw)).map(([t]) => t);
  }

  // Downloads the audio. Returns a Blob (kept for playback, so it's only fetched once).
  async function fetchAudio(track, onProgress) {
    if (track.file) return track.file;
    // songs saved before the hearthis fix still carry the .app link
    const url = (track.url || '').replace(/^https?:\/\/(www\.)?hearthis\.app\//, 'https://hearthis.at/');
    const r = await fetchRetry(url);
    if (!r.ok) throw new Error('stream ' + r.status);
    const total = +r.headers.get('content-length') || 0;
    if (!r.body || !total || !onProgress) return await r.blob();
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress(got / total);
    }
    return new Blob(parts, { type: r.headers.get('content-type') || 'audio/mpeg' });
  }

  /* ---------- local files ---------- */

  function syncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }

  function decodeText(bytes) {
    if (!bytes.length) return '';
    const enc = bytes[0], body = bytes.subarray(1);
    let s;
    try {
      if (enc === 1 || enc === 2) s = new TextDecoder(enc === 2 ? 'utf-16be' : 'utf-16').decode(body);
      else if (enc === 3) s = new TextDecoder('utf-8').decode(body);
      else s = new TextDecoder('latin1').decode(body);
    } catch (e) { s = ''; }
    return s.replace(/\u0000+$/g, '').replace(/\u0000/g, ' / ').trim();
  }

  async function readId3(file) {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
    const ver = head[3];
    const size = syncsafe(head, 6);
    const b = new Uint8Array(await file.slice(10, 10 + Math.min(size, 512 * 1024)).arrayBuffer());
    const out = {};
    let o = 0;
    while (o + 10 < b.length) {
      const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fs = ver === 4 ? syncsafe(b, o + 4) : (b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7];
      if (fs <= 0 || o + 10 + fs > b.length) break;
      const data = b.subarray(o + 10, o + 10 + fs);
      if (id === 'TIT2') out.title = decodeText(data);
      else if (id === 'TPE1') out.artist = decodeText(data);
      else if (id === 'TCON') out.genre = decodeText(data).replace(/^\(\d+\)/, '');
      else if (id === 'TLAN') out.lang = decodeText(data);
      else if (id === 'TKEY') out.key = decodeText(data);
      o += 10 + fs;
    }
    return out;
  }

  async function fromFile(file) {
    let tags = {};
    try { tags = await readId3(file); } catch (e) { /* ignore */ }
    const base = file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    let artist = tags.artist, title = tags.title;
    if (!title) {
      const m = base.split(' - ');
      if (m.length >= 2) { artist = artist || m[0].trim(); title = m.slice(1).join(' - ').trim(); }
      else title = base;
    }
    return {
      id: 'lf:' + file.name + '|' + file.size,
      src: 'local',
      file,
      title: title || base,
      artist: artist || 'Unknown',
      artwork: '',
      genre: tags.genre || '',
      mood: '',
      tags: (tags.lang || '').toLowerCase(),
      description: '',
      duration: 0,
      plays: 0,
      metaBpm: null,
      key: tags.key || null,
      verified: true,
      link: '',
    };
  }

  root.DJSources = { audiusUser, search, searchAll, searchArtist, searchHearthis, hearthisGenre, archive, trending, fetchAudio, fromFile, tidyTitle };
})(window);
