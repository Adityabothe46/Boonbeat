/* Your favourite songs: Boonbeat searches for them first, plays them with priority (remixed versions too,
   since some only exist as DJ edits on the free sources), boosts their artists, and learns their sound.
   Starts with the Hindi party list you shared; add more in the app ("Your favourite songs"). */
(function (root) {
  'use strict';
  const KEY = 'aidj.favorites';
  const DEFAULT = [
    ['Desi Kalakaar', 'Yo Yo Honey Singh'], ['Love Dose', 'Yo Yo Honey Singh'], ['Blue Eyes', 'Yo Yo Honey Singh'],
    ['Bom Diggy Diggy', 'Zack Knight, Jasmin Walia'], ['Do You Love Me', 'Nikhita Gandhi, Tanishk Bagchi'], ['Jalebi Baby', 'Tesher'],
    ['Chammak Challo', 'Akon, Hamsika Iyer'], ['Brown Rang', 'Yo Yo Honey Singh'], ['Amplifier', 'Imran Khan'],
    ['Getup Jawani', 'Badshah, Yo Yo Honey Singh'], ['Chiggy Wiggy', 'Kylie Minogue, Sonu Nigam'],
    ['High Heels Te Nachche', 'Meet Bros, Yo Yo Honey Singh, Jaz Dhami'], ['Chhote Chhote Peg', 'Yo Yo Honey Singh, Neha Kakkar, Navraj Hans'],
    ['Pink Lips', 'Khushboo Grewal, Meet Bros Anjjan'], ['Sooraj Dooba Hain', 'Arijit Singh, Aditi Singh Sharma'],
    ['Dilliwaali Girlfriend', 'Pritam, Arijit Singh, Sunidhi Chauhan'], ['Badtameez Dil', 'Pritam, Benny Dayal, Shefali Alvares'],
    ['Party All Night', 'Yo Yo Honey Singh'], ['Subha Hone Na De', 'Pritam, Mika Singh, Shefali Alvares'],
    ['Baby Doll', 'Kanika Kapoor, Meet Bros Anjjan'], ['Dil Chori', 'Yo Yo Honey Singh, Simar Kaur, Ishers'],
    ['Abhi Toh Party Shuru Hui Hai', 'Badshah, Aastha Gill'],
  ];

  let list = null;
  function load() {
    if (list) return list;
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (Array.isArray(v) && v.length) list = v; } catch (e) { /* default */ }
    // your starting list is your Hindi party list (Jalebi Baby or Chammak Challo can look English from the title alone)
    if (!list) list = DEFAULT.map(([title, artist]) => ({ title, artist, lang: 'hindi' }));
    return list;
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* ignore */ } };

  // loose matching: case, punctuation and common Bollywood spelling variants (aa/a, ee/i, w/v, double letters)
  const loose = s => (s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/w/g, 'v').replace(/z/g, 'j').replace(/ph/g, 'f')
    .replace(/([a-z])\1+/g, '$1').replace(/h\b/g, '').replace(/\s+/g, ' ').trim();

  const firstArtists = f => f.artist.split(/,|&| and | x /i).map(a => a.trim()).filter(Boolean);

  // everyday English words: a title made only of these ("Do You Love Me", "Baby Doll") is too common to trust alone
  const ENGLISHY = new Set(('a an the i me my you your we us he she it they do did love dose baby doll pink lips blue eyes party all night ' +
    'girl girlfriend boy dance high heels low get up go come on in out with to of for and or is are be like want need my hot sexy ' +
    'crazy good bad time life heart dil why what when how this that one two up down shake bounce move body lady beautiful queen king').split(' ').map(w => loose(w)));
  const englishOnly = s => s.split(' ').every(w => ENGLISHY.has(w));
  // "Meet Bros Anjjan" should also match "Meet Bros"; "Yo Yo Honey Singh" also "Honey Singh"
  const artistForms = a => { const l = loose(a).replace(/^yo yo /, ''); const w = l.split(' '); return w.length >= 3 ? [l, w.slice(0, 2).join(' ')] : [l]; };

  // which favourite (if any) is this track?
  function match(t) {
    const tt = ' ' + loose(t.title) + ' ';
    for (const f of load()) {
      const want = loose(f.title);
      if (want.length < 3 || !tt.includes(' ' + want + ' ')) continue;
      // short or plain-English titles ("Love Dose", "Baby Doll", "Do You Love Me") must also name one of the artists
      if (want.split(' ').length <= 2 || englishOnly(want)) {
        const hay = ' ' + loose(t.title + ' ' + t.artist + ' ' + (t.tags || '') + ' ' + (t.description || '')) + ' ';
        if (!firstArtists(f).some(a => artistForms(a).some(x => x.length > 2 && hay.includes(' ' + x + ' ')))) continue;
      }
      return f;
    }
    return null;
  }

  // all artists named in your favourites ("Meet Bros", "Kanika Kapoor", ...)
  function artists() {
    const out = new Set();
    for (const f of load()) for (const a of firstArtists(f)) out.add(a);
    return [...out];
  }

  // "Song - Artist" per line (also accepts "Song by Artist" or just "Song")
  function setFromText(text) {
    const before = load();
    const rows = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.split(/\s+[-–—]\s+|\s+by\s+/i);
      const r = { title: m[0].trim(), artist: (m[1] || '').trim() };
      // a song already on the list keeps its language; new ones get it worked out from title and artist
      const old = before.find(f => loose(f.title) === loose(r.title));
      if (old && old.lang) r.lang = old.lang;
      return r;
    }).filter(r => r.title.length > 1);
    if (rows.length) { list = rows; save(); }
    return list;
  }
  const asText = () => load().map(f => f.artist ? `${f.title} - ${f.artist}` : f.title).join('\n');
  function reset() { list = null; try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } return load(); }

  root.DJFav = { list: load, match, artists, setFromText, asText, reset, loose };
})(window);
