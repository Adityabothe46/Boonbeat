/* The DJ brain: classifies songs (language, mood, energy) and picks what plays next. */
(function (root) {
  'use strict';

  /* ---------- modes ---------- */
  const MODES = {
    dance: {
      label: 'Dance Floor', beatmatch: true, full: false, playLen: [150, 210], fadeSec: 6, minPlay: 95, maxPlay: 220, needH: 2, doubleDrop: 0.2,
      bpm: [95, 150], want: 'dance',
      // warm start (first 3 songs), then waves: build, peak (anthems), short breather, repeat
      target: n => n < 3 ? 0.66 + 0.07 * n : Math.min(0.95, 0.8 + 0.12 * Math.sin(((n - 3) / 6) * 2 * Math.PI) - ((n - 3) % 6 === 5 ? 0.08 : 0)),
    },
    warmup: {
      label: 'Warm Up', beatmatch: true, full: false, playLen: [170, 230], fadeSec: 7, minPlay: 130, maxPlay: 260, needH: 2, doubleDrop: 0,
      bpm: [88, 135], want: 'dance',
      target: n => Math.min(0.85, 0.45 + n * 0.035),
    },
    romantic: {
      label: 'Romantic', beatmatch: false, full: true, fadeSec: 10,
      bpm: [55, 115], want: 'romantic',
      target: () => 0.25,
    },
    chill: {
      label: 'Chill', beatmatch: false, full: true, fadeSec: 7,
      bpm: [60, 125], want: 'chill',
      target: () => 0.4,
    },
  };

  const LANGS = {
    hindi: ['hindi'], punjabi: ['punjabi'], desi: ['hindi', 'punjabi'], english: ['english'],
    mix: ['hindi', 'punjabi', 'english'],
  };

  /* ---------- what to fetch from Audius per mode and language ----------
     Audit (Nov 2026): genre words ("bollywood remix", "hindi remix") return mostly remixes, while artist
     names return the original hits (reuploads of Honey Singh, Badshah, Diljit, AP Dhillon, Sidhu Moose Wala...).
     So the DJ searches by artist. 'a:Name' = artist search on Audius + hearthis (the track must credit the artist),
     'g:Genre' = Audius trending in that genre, 'h:slug' = a hearthis.at genre feed,
     'ia:subject' = Internet Archive netlabel releases (Creative Commons), anything else = plain search. */
  const A = list => list.map(n => 'a:' + n);
  // official accounts on Audius (artists and labels posting their own releases), by the kind of set they suit
  const O = hs => hs.map(h => 'o:' + h);
  const OFFICIAL = {
    dance: O(['Dirtybird', 'disclosure', 'DillonFrancis', 'CheatCodesMusic', 'alunaaa', 'Xdmrecords', 'revealedrec', 'SJ_RM', 'saknoel',
      'sickickmusic', 'kelland', 'Brozrdz', 'kylekinch', 'camouflybeats', 'Lookas', 'jacknifemusic', 'TomBudin', 'dombresky', 'kohmimusic',
      'AUSTINMILLZ', 'KapSlap', 'ShipWrekDJ', 'whaskii', 'wuki', 'RAC', 'deadmau5', 'boysnoize', 'jayceeoh', 'bitbird', 'BlackHoleRec',
      'oliveriolujan', 'fattybass', 'cryptoravers', 'markcastdj', 'hi_mija', 'zaza', 'BasstrickMusic', 'lemaestromind']),
    warmup: O(['anjunadeep', 'disclosure', 'alunaaa', 'RAC', 'hi_mija', 'Xdmrecords', 'CodesHouse', 'chakrarecords', 'millionrecords_',
      'broeybeats', 'kevinmckay', 'xinobimusic', 'WaxMotif', 'Tensnake', 'yungbae', 'SNOmad1', 'veggibeats', 'paulineherr', 'Jazcardan', 'surayofficial']),
    romantic: O(['masego', 'joshpan', 'destinconrad', 'floydfuji', 'angelina_alexon', 'col3trane', 'iamjmsn', 'ChrisScholar', 'imnoahguy', 'collegemusic']),
    chill: O(['collegemusic', 'chillhopmusic', 'slowmagic', 'RAC', 'hotelgaruda', 'soundslikesaka', 'sablevalley', 'paulineherr', '_Qrion_', 'anjunadeep', 'snoozegod']),
  };
  const QUERIES = {
    dance: {
      hindi: A(['Yo Yo Honey Singh', 'Badshah', 'Neha Kakkar', 'Guru Randhawa', 'Tony Kakkar', 'Raftaar', 'Mika Singh', 'Sunidhi Chauhan',
        'Vishal Dadlani', 'Benny Dayal', 'Tanishk Bagchi', 'Sukhwinder Singh', 'Pritam', 'Vishal Shekhar', 'Divine', 'Jasmine Sandlas']).concat(['bollywood party', 'bollywood dance', 'h:bollywood', 'h:indian']),
      punjabi: A(['Diljit Dosanjh', 'AP Dhillon', 'Karan Aujla', 'Sidhu Moose Wala', 'Shubh', 'Imran Khan', 'Jass Manak', 'Gippy Grewal',
        'Jazzy B', 'Daler Mehndi', 'Panjabi MC', 'Harrdy Sandhu', 'Parmish Verma', 'Bohemia', 'Garry Sandhu']).concat(['bhangra', 'punjabi', 'h:indian']),
      english: A(['Dua Lipa', 'Pitbull', 'Calvin Harris', 'David Guetta', 'Bruno Mars', 'Rihanna', 'Drake', 'The Weeknd', 'Shakira', 'Black Eyed Peas', 'Usher', 'Flo Rida'])
        .concat(['g:Electronic', 'g:House', 'g:Tech House', 'g:Dance & EDM', 'g:Moombahton', 'dance pop',
          'h:dance', 'h:pop', 'h:edm', 'h:house', 'h:techhouse', 'h:hiphop', 'ia:house', 'ia:dance', 'ia:electro', 'ia:disco']),
    },
    warmup: {
      hindi: A(['Badshah', 'Guru Randhawa', 'Neha Kakkar', 'Tony Kakkar', 'Pritam', 'Darshan Raval', 'Jubin Nautiyal', 'Yo Yo Honey Singh']).concat(['h:bollywood']),
      punjabi: A(['AP Dhillon', 'Shubh', 'Karan Aujla', 'Diljit Dosanjh', 'Harrdy Sandhu', 'Imran Khan']),
      english: A(['Dua Lipa', 'Bruno Mars', 'The Weeknd', 'Calvin Harris']).concat(['g:Deep House', 'g:House', 'g:Tropical House', 'g:Disco', 'nu disco', 'h:deephouse', 'h:organichouse', 'h:pop', 'ia:deep house', 'ia:nu disco']),
    },
    romantic: {
      hindi: A(['Arijit Singh', 'Atif Aslam', 'Jubin Nautiyal', 'Shreya Ghoshal', 'Armaan Malik', 'Darshan Raval', 'Vishal Mishra', 'Mohit Chauhan',
        'KK', 'Sonu Nigam', 'Jasleen Royal', 'Stebin Ben', 'Sachet Tandon', 'Rahat Fateh Ali Khan', 'Lata Mangeshkar', 'Kishore Kumar']),
      punjabi: A(['B Praak', 'Ammy Virk', 'Satinder Sartaaj', 'Jassie Gill', 'Sajjan Adeeb', 'Gurnam Bhullar', 'Harrdy Sandhu', 'Diljit Dosanjh']),
      english: A(['Ed Sheeran', 'Bruno Mars', 'Adele', 'John Legend', 'Justin Bieber', 'Taylor Swift', 'Sam Smith', 'Lewis Capaldi']).concat(['g:R&B/Soul', 'love song', 'h:rnb', 'h:soul']),
    },
    chill: {
      hindi: A(['Prateek Kuhad', 'Anuv Jain', 'Lucky Ali', 'Ritviz', 'Arijit Singh', 'Mohit Chauhan', 'Papon', 'Amit Trivedi']).concat(['hindi lofi', 'h:lofi']),
      punjabi: A(['AP Dhillon', 'B Praak', 'Satinder Sartaaj', 'Ammy Virk']).concat(['punjabi lofi']),
      english: A(['Ed Sheeran', 'Coldplay', 'Billie Eilish', 'Lana Del Rey']).concat(['g:Lo-Fi', 'g:Acoustic', 'chillhop', 'h:chillout', 'h:acoustic', 'ia:downtempo', 'ia:chillout']),
    },
  };

  /* ---------- which version is this? Originals first ---------- */
  const ALTERED = /\b(slowed|reverb|sped ?up|speed ?up|8d|16d|3d audio|nightcore|screwed|chopped (and|n|&) screwed|bass ?boost(ed)?|daycore|tiktok version)\b/i;
  // ("Radio Edit" is the original single, so it doesn't count as an edit)
  // ("Original Mix" is the original in dance music; "Electro Mix", "Desi Mix", "- DJ Smilee" are DJ versions)
  const REMIX = /\b(remix|rmx|re-?work|refix|bootleg|mashup|mash-up|flip|vip|club mix|dub mix|extended mix|megamix|medley)\b|(?<!radio )\bedit\b|\bdj\s+\w+.*\)|\(dj\b|\b(?!original\b)[a-z]+\s+mix\b|[-–|]\s*dj\s+\w+/i;
  const COVER = /\b(cover|covered by|karaoke|instrumental|unplugged version|piano version|acoustic version|female version|male version|reprise)\b/i;
  const LOFI = /\b(lo-?fi)\b/i;
  function versionOf(t) {
    const title = t.title || '';
    if (ALTERED.test(title)) return 'altered';
    if (t.remixOf || REMIX.test(title)) return 'remix';
    if (COVER.test(title)) return 'cover';
    if (LOFI.test(title)) return 'lofi';
    return 'original';
  }

  // Hindi mode also takes Punjabi party songs (with a small penalty): Bollywood party sets always mix them in
  const langAllowed = (lang, sel) => LANGS[sel].includes(lang) || (sel === 'hindi' && lang === 'punjabi');

  function queriesFor(mode, lang) {
    const out = [];
    // English sets start from official releases (real originals), then the wider searches
    if (LANGS[lang].includes('english')) out.push(...OFFICIAL[mode]);
    for (const l of LANGS[lang]) for (const q of QUERIES[mode][l]) out.push(q);
    // your favourite songs, searched one by one, plus the artists on them
    // (only the favourites that belong to the language you picked: your Hindi party list stays out of English sets)
    const F = root.DJFav;
    if (F) {
      const mine = F.list().filter(f => langAllowed(favLang(f), lang));
      for (const f of mine) out.unshift('s:' + f.title + (f.artist ? '|' + f.artist : ''));
      const names = new Set();
      for (const f of mine) for (const a of f.artist.split(/,|&| and | x /i).map(x => x.trim()).filter(Boolean)) names.add(a);
      for (const a of names) if (!out.includes('a:' + a)) out.push('a:' + a);
    }
    return out;
  }

  /* ---------- language detection ---------- */
  const HI_WORDS = ['dil', 'pyaar', 'pyar', 'ishq', 'mohabbat', 'tera', 'teri', 'tere', 'mera', 'meri', 'mere', 'tujhe', 'mujhe',
    'sajna', 'saiyaan', 'saiyan', 'jaan', 'yaara', 'sanam', 'dilbar', 'mahi', 'zindagi', 'khuda', 'aankhon', 'raat', 'chand',
    'baarish', 'nachle', 'naach', 'kya', 'kaise', 'hai', 'hain', 'tum', 'hum', 'jhoom', 'dhadkan', 'deewani', 'deewana',
    'mastani', 'saathiya', 'kabhi', 'kahin', 'chaiyya', 'munni', 'sheila', 'badtameez', 'balam', 'jalwa', 'piya', 'rabba',
    'humko', 'tumhe', 'tumse', 'hoon', 'nahi', 'kuch', 'koi', 'pehla', 'pagal', 'jawani', 'gali', 'kajra', 'malang', 'mehbooba',
    'sapna', 'tujhse', 'saajan', 'chalo', 'aaja', 'bole', 'chudiyan', 'thumka', 'ghoomar', 'naina', 'jiya', 'mann',
    'kho', 'gya', 'gaya', 'hua', 'tha', 'dobara', 'judaai', 'bewafa', 'yaadein', 'khwab', 'ishqa', 'mujhko', 'tujhko'];
  const PA_WORDS = ['kudi', 'kudiyan', 'munda', 'jatt', 'jatti', 'balle', 'bhangra', 'gabru', 'patola', 'yaariyan', 'sohneya',
    'sohni', 'mitran', 'tenu', 'menu', 'kithe', 'laung', 'laachi', 'pagg', 'nachna', 'vekh', 'shaunki', 'putt', 'jattan',
    'gidha', 'giddha', 'punjab', 'punjabi', 'lahore', 'dhol', 'jugni', 'pind', 'kaint', 'yaar'];
  const HI_ARTISTS = ['arijit', 'shreya ghoshal', 'neha kakkar', 'pritam', 'atif aslam', 'sonu nigam', 'vishal-shekhar',
    'vishal shekhar', 'a.r. rahman', 'ar rahman', 'a r rahman', 'sunidhi', 'mohit chauhan', 'jubin', 'darshan raval',
    'armaan malik', 'amit trivedi', 'vishal dadlani', 'benny dayal', 'tanishk', 'kumar sanu', 'udit narayan',
    'lata mangeshkar', 'kishore kumar', 'mohammed rafi', 'asha bhosle', 'alka yagnik', 'sukhwinder', 'monali thakur',
    'palak muchhal', 'sachet', 'javed ali', 'shankar mahadevan', 'salim-sulaiman', 'himesh', 'badshah', 'raftaar', 'divine',
    'emiway', 'nucleya', 'ritviz', 'prateek kuhad', 'anuv jain', 'lucky ali', 'papon', 'sachin-jigar', 'vishal mishra',
    'stebin ben', 'dj chetas', 'dj notorious', 'dj aqeel', 'dj suketu', 'kedrock', 'dj nyk', 'king', 'mitraz', 'tony kakkar',
    'rahat fateh', 'shreya', 'armaan', 'mohit chauhan', 'sonu nigam', 'jasleen', 'sachet tandon', 'amit trivedi', 'prateek kuhad',
    'anuv jain', 'lucky ali', 'mika singh', 'vishal dadlani', 'tanishk bagchi', 'sukhwinder', 'sunidhi', 'jubin nautiyal', 'kk'];
  const PA_ARTISTS = ['diljit', 'ap dhillon', 'karan aujla', 'sidhu moose', 'guru randhawa', 'harrdy sandhu', 'gippy grewal',
    'ammy virk', 'jassie gill', 'garry sandhu', 'shubh', 'jass manak', 'babbu maan', 'gurdas maan', 'daler mehndi',
    'panjabi mc', 'jazzy b', 'sukhbir', 'parmish verma', 'mankirt', 'b praak', 'jasmine sandlas', 'nimrat khaira',
    'sunanda sharma', 'amrit maan', 'honey singh', 'bohemia', 'imran khan', 'jasleen', 'satinder sartaaj', 'sajjan adeeb',
    'gurnam bhullar', 'jassie gill', 'jazzy b', 'daler mehndi', 'panjabi mc', 'parmish verma', 'harrdy sandhu', 'shubh'];

  const BOTH_ARTISTS = ['yo yo honey singh', 'honey singh', 'guru randhawa', 'b praak', 'jasmine sandlas', 'harrdy sandhu', 'mika singh', 'daler mehndi', 'jassie gill', 'sukhwinder singh', 'asees kaur'];
  const wordSet = arr => new Set(arr);
  const HI = wordSet(HI_WORDS), PA = wordSet(PA_WORDS);
  const PA_PARTICLES = wordSet(['da', 'di', 'de', 've', 'ni', 'nu', 'naa', 'chalda', 'sadda', 'saade', 'kardi', 'gallan']);

  /* Is this artist actually *credited* on the track? (not just a word in the title)
     "295 - Sidhu Moose Wala", "Kohinoor | DIVINE", "ft. Badshah", "DIVINE x Raftaar", or the uploader's name.
     "Divine Frequency" / "Something Divine" are not DIVINE songs. One-word names (DIVINE, King, Shubh)
     must sit in a credit position; longer names may also simply end the title ("Blue Eyes Yo Yo Honey Singh"). */
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const creditCache = new Map();
  function creditRes(name) {
    let r = creditCache.get(name);
    if (r) return r;
    const words = name.toLowerCase().replace(/^yo yo /, '').split(/\s+/).filter(Boolean);
    const n = words.map(reEsc).join('[\\s._-]+');
    const pre = name.toLowerCase().startsWith('yo yo ') ? '(?:yo[\\s._-]*yo[\\s._-]+)?' : '';
    const sep = '(?:^|[-–—|,&/(\\[:]|\\bx\\b|\\bft\\.?|\\bfeat\\.?|\\bfeaturing\\b|\\bby\\b|\\bwith\\b|\\bvs\\.?|\\band\\b)';
    const end = '(?:$|[-–—|,&/)\\]:(]|\\bx\\b|\\bft\\.?|\\bfeat\\.?|\\band\\b|\\s+(?:official|song|songs|music|video|audio|lyrics?|full|new|latest|remix|hd|\\d{2,4})\\b)';
    r = {
      artist: new RegExp('(^|[^a-z0-9])' + pre + n + '($|[^a-z0-9])'),
      credit: new RegExp(sep + '\\s*' + pre + n + '\\s*' + end),
      tail: words.length > 1 ? new RegExp('(^|\\s)' + pre + n + '\\s*$') : null,
    };
    creditCache.set(name, r);
    return r;
  }
  // one-word artist names that are also everyday English words: "ALP3R - Divine" is a song called Divine,
  // and an uploader called "Divine Soul" isn't DIVINE. These need a stricter credit.
  const AMBIGUOUS = new Set(['divine', 'king', 'kk', 'shubh', 'ikka', 'raja']);
  function credited(t, name) {
    const r = creditRes(name);
    const artist = (t.artist || '').toLowerCase().trim(), title = (t.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const key = name.toLowerCase();
    if (AMBIGUOUS.has(key)) {
      const n = reEsc(key);
      if (artist.replace(/[^a-z0-9 ]+/g, ' ').trim() === key) return true;                    // the uploader IS the artist
      if (new RegExp(String.raw`(\bft\.?|\bfeat\.?|\bfeaturing\b|\bx\b|&|,)\s*` + n + String.raw`\b`).test(title)) return true; // "ft. DIVINE", "x DIVINE"
      if (new RegExp('^' + n + String.raw`\s*(x|&|,|ft\.?|feat\.?)\s`).test(title)) return true;  // "DIVINE x Raftaar - ..."
      if (new RegExp('^' + n + String.raw`\s*[-–—|:]\s`).test(title)) return true;                  // "DIVINE - Kohinoor"
      if (new RegExp(String.raw`\|\s*` + n + String.raw`\s*$`).test(title)) return true;            // "Kohinoor | DIVINE"
      return (t.taggedArtists || []).some(a => String(a).toLowerCase().trim() === key);
    }
    if (r.artist.test(artist)) return true;
    if (r.credit.test(title)) return true;
    if (r.tail && r.tail.test(title)) return true;
    return (t.taggedArtists || []).some(a => r.artist.test(String(a).toLowerCase()));
  }

  // other Indian languages (not Hindi or Punjabi): kept out of every language choice
  const REGIONAL = /\b(marathi|tamil|telugu|kannada|malayalam|bengali|bangla|bhojpuri|gujarati|odia|oriya|halbi|chhattisgarhi|cg song|nagpuri|sambalpuri|garhwali|kumaoni|haryanvi|rajasthani|assamese|konkani|tulu|sinhala|nepali|pahadi|kollywood|tollywood|sandalwood|mollywood)\b/;

  function detectLanguage(t) { return langInfo(t).lang; }
  // { lang, sure }: sure is false when the only hint is a tag the uploader chose
  // a favourite's language: what the list says, else read from its title and artists
  function favLang(f) {
    if (f.lang) return f.lang;
    const r = detectLanguageRaw({ title: f.title, artist: f.artist, tags: '', genre: '', description: '' });
    return r.lang;
  }
  function langInfo(t) {
    if (t.langManual) return { lang: t.langManual, sure: true };
    // an upload of one of your favourites has that favourite's language, whatever the uploader wrote
    const fav = root.DJFav && root.DJFav.match(t);
    if (fav) return { lang: favLang(fav), sure: true };
    const r = detectLanguageRaw(t);
    return r;
  }
  // words that only Spanish titles use count 1; short words English shares ("me", "la", "de") count half
  const ES_STRONG = new Set(('que tu mi los las del con para por amor corazon bailar baila bailando quiero todo toda viene llego esta como sin mas noche vida fuego ' +
    'mami papi bonito bonita besame perreo dale vamos tiburon aqui senora loca loco una eres soy ella nada siempre nunca mundo cielo luna contigo ' +
    'quieres tengo tienes hasta donde cuando porque solo sola cuerpo boca beso besos fiesta caliente ritmo musica mujer hombre otra otro nuestra nuestro').split(' '));
  const ES_WEAK = new Set('el la y de me te se lo le pa va mas yo'.split(' '));
  function spanishScore(title, tags) {
    const plain = title.normalize('NFD').replace(/[̀-ͯ]/g, '');
    let s = /[ñ¿¡]/.test(title) ? 2 : /[áéíóú]/.test(title) ? 1 : 0;
    for (const w of plain.split(/[^a-z]+/).filter(Boolean)) s += ES_STRONG.has(w) ? 1 : ES_WEAK.has(w) ? 0.5 : 0;
    if (/\b(reggaeton|bachata|salsa|cumbia|dembow|latin)\b/.test(tags)) s += 0.5;
    return s;
  }
  function detectLanguageRaw(t) {
    const title = (t.title || '').toLowerCase();
    const artist = (t.artist || '').toLowerCase();
    const tags = (t.tags || '') + ' ' + (t.genre || '').toLowerCase();
    const desc = (t.description || '').toLowerCase();
    const all = title + ' ' + artist + ' ' + tags;
    let hi = 0, pa = 0;
    if (/[਀-੿]/.test(all)) pa += 4;
    if (/[ऀ-ॿ]/.test(all)) hi += 4;
    if (REGIONAL.test(all + ' ' + desc)) return { lang: 'other', sure: true };
    let tagHi = 0, tagPa = 0;
    if (/\b(punjabi|bhangra)\b/.test(tags)) tagPa += 3;
    if (/\b(hindi|bollywood|desi|filmi|hindustani)\b/.test(tags)) tagHi += 3;
    else if (/\bindian\b/.test(tags)) tagHi += 1;   // "Indian" also covers regional, Tamil, Telugu... only a hint
    if (/\b(punjabi|bhangra)\b/.test(title)) pa += 2;
    if (/\b(bollywood|desi|filmi)\b/.test(title)) hi += 2;
    // "hindi" is also a Tagalog word ("hindi ko", "hindi tayo"), so only count it when it isn't used that way
    if (/\bhindi\b/.test(title)) hi += /\bhindi (ko|ka|mo|na|tayo|lang|kita|ba|pa|siya|man)\b/.test(title) ? 0 : 2;
    if (/\b(bollywood|hindi)\b/.test(desc)) hi += 1;
    if (/\b(punjabi|bhangra)\b/.test(desc)) pa += 1;
    // known artists only count when they're credited on the track (see credited())
    // artists who sing in both Hindi and Punjabi: the song's own words decide
    let both = false;
    for (const a of BOTH_ARTISTS) if (credited(t, a)) { hi += 2; pa += 2; both = true; break; }
    if (!both) {
      for (const a of PA_ARTISTS) if (credited(t, a)) { pa += 3; break; }
      for (const a of HI_ARTISTS) if (credited(t, a)) { hi += 3; break; }
    }
    // uploader channels named after the language ("Punjabi Songs", "Bollywood Hits")
    if (/\b(punjabi|bhangra)\b/.test(artist)) pa += 2;
    if (/\b(bollywood|hindi|desi)\b/.test(artist)) hi += 2;
    const words = title.split(/[^a-z]+/).filter(Boolean);
    let hw = 0, pw = 0;
    for (const w of words) { if (HI.has(w)) hw++; if (PA.has(w)) pw++; }
    // short Punjabi particles only count once the title already looks desi
    if (hw + pw > 0) for (const w of words) if (PA_PARTICLES.has(w)) pw++;
    hi += Math.min(3, hw); pa += Math.min(3, pw);
    // evidence from the track itself (title, artist, script, words) vs. only the uploader's tags
    const own = hi + pa;
    hi += tagHi; pa += tagPa;
    // Spanish songs (Latin house labels post a lot of them) are not English: keep them out of English sets
    if (hi < 2 && pa < 2 && spanishScore(title, tags) >= 2) return { lang: 'other', sure: true };
    let lang = 'english';
    if (pa >= 2 && pa >= hi) lang = 'punjabi';
    else if (hi >= 2) lang = 'hindi';
    else if (pa >= 2) lang = 'punjabi';
    return { lang, sure: lang === 'english' || own >= 2 };
  }

  /* ---------- energy + mood ---------- */
  const MOOD_E = {
    energizing: 0.85, upbeat: 0.8, excited: 0.85, aggressive: 0.9, fiery: 0.9, rowdy: 0.85, empowering: 0.7,
    stirring: 0.65, defiant: 0.75, gritty: 0.7, cool: 0.5, sophisticated: 0.5, easygoing: 0.4, brooding: 0.4,
    sensual: 0.35, romantic: 0.3, yearning: 0.3, sentimental: 0.25, melancholy: 0.2, tender: 0.2, peaceful: 0.15,
  };
  const GENRE_E = [
    [/drum ?& ?bass|dubstep|hardstyle|trap|techno|moombahton/, 0.88], [/tech house|electro|edm|dance|future bass/, 0.82],
    [/^house|trance|disco/, 0.78], [/deep house|tropical/, 0.62], [/electronic/, 0.72], [/hip-hop|rap/, 0.7],
    [/pop|latin|reggaeton|afro/, 0.62], [/rock|metal|punk/, 0.7], [/r&b|soul|jazz/, 0.4], [/world|soundtrack|indie/, 0.45],
    [/acoustic|folk|singer/, 0.28], [/lo-?fi|ambient|classical|piano/, 0.18],
  ];
  const ROM_WORDS = /\b(love|romantic|romance|ishq|pyaar|pyar|mohabbat|unplugged|acoustic|lofi|lo-fi|slowed|reverb|tum|dil|sanam|jaan)\b/i;

  function metaEnergy(t) {
    let e = 0.55, n = 0, s = 0;
    const m = (t.mood || '').toLowerCase();
    if (MOOD_E[m] != null) { s += MOOD_E[m]; n++; }
    const g = (t.genre || '').toLowerCase();
    for (const [re, v] of GENRE_E) if (re.test(g)) { s += v; n++; break; }
    if (t.metaBpm) { s += Math.min(1, Math.max(0, (Math.min(t.metaBpm, 150) - 70) / 60)) * 0.9; n++; }
    if (/\b(lofi|lo-fi|slowed|unplugged|acoustic)\b/i.test(t.title)) { s += 0.15; n++; }
    if (/\b(remix|club|edit|bootleg|mashup|party)\b/i.test(t.title)) { s += 0.8; n++; }
    if (n) e = s / n;
    return e;
  }

  // library-relative ranking of analysed energy
  const analysedEnergies = [];
  function noteAnalysed(raw) {
    let i = 0;
    while (i < analysedEnergies.length && analysedEnergies[i] < raw) i++;
    analysedEnergies.splice(i, 0, raw);
  }
  function rankOf(raw) {
    const n = analysedEnergies.length;
    if (n < 8) return raw;
    let i = 0;
    while (i < n && analysedEnergies[i] < raw) i++;
    return 0.5 * (i / n) + 0.5 * raw;
  }

  function energyOf(t) {
    const me = metaEnergy(t);
    if (!t.a) return me;
    if (t.ml) return 0.45 * rankOf(t.a.energyRaw) + 0.25 * me + 0.3 * t.ml.party;
    return 0.6 * rankOf(t.a.energyRaw) + 0.4 * me;
  }

  function moodOf(t) {
    if (t.moodManual) return t.moodManual;
    const e = energyOf(t);
    const m = (t.mood || '').toLowerCase();
    const romMood = ['romantic', 'sentimental', 'tender', 'yearning', 'sensual', 'melancholy'].includes(m);
    if ((romMood || ROM_WORDS.test(t.title + ' ' + t.tags)) && e < 0.62) return 'romantic';
    if (e >= 0.6) return 'dance';
    return 'chill';
  }

  /* ---------- harmonic mixing (Camelot wheel) ---------- */
  const MINOR = { 'G#': 1, 'Ab': 1, 'D#': 2, 'Eb': 2, 'A#': 3, 'Bb': 3, 'F': 4, 'C': 5, 'G': 6, 'D': 7, 'A': 8, 'E': 9, 'B': 10, 'F#': 11, 'Gb': 11, 'C#': 12, 'Db': 12 };
  const MAJOR = { 'B': 1, 'Cb': 1, 'F#': 2, 'Gb': 2, 'C#': 3, 'Db': 3, 'G#': 4, 'Ab': 4, 'D#': 5, 'Eb': 5, 'A#': 6, 'Bb': 6, 'F': 7, 'C': 8, 'G': 9, 'D': 10, 'A': 11, 'E': 12 };
  function camelot(key) {
    if (!key) return null;
    const k = key.trim().replace(/\s+flat/i, 'b').replace(/\s+sharp/i, '#').replace(/♭/g, 'b').replace(/♯/g, '#');
    const m = k.match(/^([A-Ga-g])([b#]?)\s*(m(?:in(?:or)?)?|maj(?:or)?)?$/i) || k.match(/^([A-Ga-g])([b#]?)\s+(minor|major)$/i);
    if (!m) return null;
    const note = m[1].toUpperCase() + (m[2] || '');
    const minor = /^m(in)?/i.test(m[3] || '') && !/^maj/i.test(m[3] || '');
    const num = minor ? MINOR[note] : MAJOR[note];
    return num ? { n: num, l: minor ? 'A' : 'B' } : null;
  }
  // a track's key: the uploader's tag if it has one, otherwise the key Boonbeat detected from the audio
  const keyOf = t => (t && (t.key || (t.a && t.a.keyDetected))) || null;
  function keyCompat(a, b) {
    const x = camelot(a), y = camelot(b);
    if (!x || !y) return 0.5;
    const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
    if (x.l === y.l) return d === 0 ? 1 : d === 1 ? 0.85 : d === 2 ? 0.35 : 0;
    return d === 0 ? 0.8 : 0.1;
  }

  /* ---------- tempo match ---------- */
  function bpmOf(t) { return t.a ? t.a.bpm : t.metaBpm; }
  function tempoRatio(fromBpm, toBpm) {
    // playbackRate the incoming song needs to match, allowing half/double time
    let best = null;
    for (const m of [1, 2, 0.5]) {
      const r = fromBpm / (toBpm * m);
      if (!best || Math.abs(Math.log(r)) < Math.abs(Math.log(best.rate))) best = { rate: r, mult: m };
    }
    return best;
  }

  /* ---------- picking ---------- */
  const popularity = t => Math.min(1, Math.log10((t.plays || 0) + 8 * (t.favs || 0) + 12 * (t.reposts || 0) + 1) / 5);
  const cosine = (a, b) => { if (!a || !b) return null; let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? d / Math.sqrt(na * nb) : null; };
  const dist = (a, b) => { if (!a || !b) return null; let d = 0; for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) * (a[i] - b[i]); return Math.sqrt(d); };

  // the song itself, without remix/DJ/upload noise: "Imran Khan - Amplifier (REICK Remix)" -> "amplifier"
  const NOISE = /\b(remix|rmx|mix|edit|version|official|video|audio|lyrics?|full|song|hd|hq|dj|feat|ft|prod|by|original|extended|club|bootleg|mashup|vip|\d{4}|\d+)\b/g;
  // the parts of a title that name the *song* ("Badshah - Genda Phool Remix - Saurabh Gosavi" -> ["genda phool", "saurabh gosavi"]):
  // split on " - " / " | ", strip remix/upload words, and drop parts that are an artist's name or the uploader
  let knownArtists = null;
  function songParts(t) {
    if (t._parts) return t._parts;
    if (!knownArtists) knownArtists = new Set([...HI_ARTISTS, ...PA_ARTISTS, ...BOTH_ARTISTS].map(a => a.replace(/^yo yo /, '')));
    const fav = root.DJFav ? root.DJFav.artists().map(a => a.toLowerCase().replace(/^yo yo /, '')) : [];
    const up = (t.artist || '').toLowerCase();
    const clean = p => p.replace(NOISE, ' ').replace(/\byo yo\b/g, ' ').replace(/[^a-z0-9ऀ-੿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const raw = (t.title || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ');
    t._parts = raw.split(/\s+[-–—|]\s+|\s+x\s+/).map(clean)
      .filter(p => p.length >= 4 && !knownArtists.has(p) && !fav.includes(p) && !up.includes(p));
    return t._parts;
  }
  // a different upload of something already played tonight (another remix of the same song, the same favourite)
  function alreadyHeard(t, s) {
    const F = root.DJFav, fav = F && F.match(t);
    const mine = songParts(t);
    for (const h of s.history) {
      if (fav && F.match(h) === fav) return true;
      for (const a of mine) for (const b of songParts(h)) {
        if (a === b || (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a)))) return true;
      }
    }
    return false;
  }

  // Song-level score. parts explains the choice (shown in the UI and the mix log).
  function scoreDetail(t, s) {
    const mode = MODES[s.mode];
    const li = langInfo(t), lang = li.lang;
    if (!langAllowed(lang, s.lang)) return null;
    if (s.played.has(t.id) || t.bad) return null;
    if (alreadyHeard(t, s)) return null; // no second version of a song in one night
    const ts = s.taste ? s.taste.score(t) : null;
    if (ts && ts.ban) return null; // you said never again
    const parts = {};
    const add = (k, v) => { if (v) parts[k] = Math.round(((parts[k] || 0) + v) * 100) / 100; };
    const beat = mode.beatmatch;
    if (!li.sure && lang !== 'english') add('language unsure', -0.8);

    // your favourite songs come first (a DJ edit of a favourite is fine: sometimes it's the only version here)
    const F = root.DJFav, fav = F ? F.match(t) : null;
    if (fav) add('one of your favourites', 1.3);
    else if (F && F.artists().some(a => credited(t, a))) add('artist from your favourites', 0.4);
    if (s.lang === 'hindi' && lang === 'punjabi' && !fav) add('Punjabi song', -0.4);

    // originals first: remixes and covers are second choice, slowed/reverb/8D versions never
    const ver = versionOf(t);
    if (ver === 'altered') return null;
    if (ver === 'lofi' && s.mode !== 'chill' && s.mode !== 'romantic') return null;
    if (ver === 'original') add('original version', 0.5);
    if (ver === 'original' && t.official) add('official release', 0.6);
    else if (ver === 'remix') add('remix', fav ? -0.2 : beat ? -0.6 : -1.0);
    else if (ver === 'cover') add('cover version', -0.5);

    const e = energyOf(t), target = s.energyTarget;
    add('energy fit', -3 * Math.abs(e - target));

    const mood = moodOf(t);
    if (mood === mode.want) add('mood', 0.7);
    if (s.mode === 'romantic' && mood === 'dance') add('mood', -1.5);
    if (beat && mood !== 'dance') add('mood', -1.0);

    // AI scores (Essentia MusiCNN) once the song has been heard
    if (t.ml) {
      const { party, dance, vocalShare } = t.ml;
      // party separates dance floor songs (0.7-0.96) from love songs (0-0.13) cleanly; danceability doesn't
      if (s.mode === 'dance') add('party AI', 1.6 * (party - 0.6));
      else if (s.mode === 'warmup') add('party AI', 1.0 * (party - 0.45));
      else if (s.mode === 'romantic') add('party/dance AI', -1.2 * Math.max(0, party - 0.3) + (vocalShare > 0.5 ? 0.5 : 0));
      else add('party/dance AI', -0.8 * Math.max(0, party - 0.5));
    }

    const b = bpmOf(t);
    if (b && (b < mode.bpm[0] || b > mode.bpm[1])) {
      const fits = [b * 2, b / 2].some(x => x >= mode.bpm[0] && x <= mode.bpm[1]);
      add('tempo range', fits ? -0.2 : -0.7);
    }
    const cur = s.current;
    if (beat && cur && b && bpmOf(cur)) {
      // real DJ mixes: 86% of tempo changes are under 5%
      const dev = Math.abs(tempoRatio(bpmOf(cur), b).rate - 1);
      // under 8%: a straight blend; 8-14%: blend with a tempo bridge; beyond: only a filter drop
      add('tempo match', dev < 0.03 ? 0.3 : dev < 0.05 ? 0 : dev < 0.08 ? -0.7 : dev < 0.14 ? -1.3 : -2.5);
    }
    if (cur && beat) add('key match', 0.8 * (keyCompat(keyOf(cur), keyOf(t)) - 0.5));

    // Mix: play languages in blocks of a few songs instead of flip-flopping
    if (s.lang === 'mix' && s.langBlock) {
      const blk = s.langBlock;
      if (blk.left > 0) add('language block', lang === blk.lang ? 0.6 : -0.6);
      else add('language block', lang !== blk.lang ? 0.6 : -0.6);
    }
    const recentArtists = s.history.slice(-3).map(h => h.artist);
    if (recentArtists.includes(t.artist)) add('same artist', -2);

    // crowd favourites matter most at the peaks of the set
    const peak = beat && target >= 0.88;
    add(peak ? 'anthem for the peak' : 'popularity', (peak ? 0.75 : 0.3) * popularity(t));
    if (t.verified) add('popularity', 0.1);
    // reupload compilations ("Latest Punjabi Songs 2020", "New Hindi Songs") and fake-looking play counts
    if (/\b(latest|new)\b.*\bsongs?\b|\bsongs?\s+20\d\d\b|\bcompilation\b|\bmegamix\b/i.test(t.title)) add('compilation upload', -0.5);
    if (t.src === 'audius' && t.plays > 1500 && (t.favs || 0) + (t.reposts || 0) <= 2) add('few real listeners', -0.5);
    if (t.src === 'local') add('your song', 0.4);
    if (t.a && !t.a.beatSync && beat) add('no steady beat', -0.6);
    if (ts) for (const [k, v] of Object.entries(ts.parts)) if (!(fav && k === 'you liked it')) add(k, v); // a favourite isn't counted twice

    const total = Object.values(parts).reduce((a, v) => a + v, 0);
    return { total, parts };
  }

  function score(t, s) {
    const d = scoreDetail(t, s);
    return d ? d.total + Math.random() * 0.35 : null;
  }

  /* Full transition score for an analysed candidate against the song that's playing:
     song score + the actual planned mix (vocal clash, groove match, style continuity). */
  function transitionScore(t, s, sim) {
    const d = scoreDetail(t, s);
    if (!d) return null;
    const parts = { ...d.parts };
    const add = (k, v) => { if (v) parts[k] = Math.round(((parts[k] || 0) + v) * 100) / 100; };
    const cur = s.current, mode = MODES[s.mode];
    let plan = null;
    if (cur && cur.a && t.a && mode.beatmatch) {
      const dev = Math.abs(tempoRatio(cur.a.bpm, t.a.bpm).rate - 1);
      if (cur.a.sections && t.a.sections && root.DJMixer) {
        plan = root.DJMixer.structPlan(cur.a, t.a, sim.curBar, sim.playStart, mode, dev, { anyTempo: true });
        if (!plan) add('mix plan', -0.3);
        else if (plan.clash) {
          // songs the model hears as "vocals everywhere" give a weak signal, so count their clashes for less
          const vague = (cur.ml && cur.ml.vocalShare > 0.85) || (t.ml && t.ml.vocalShare > 0.85);
          add('vocal clash', -Math.min(2.4, (vague ? 0.15 : 0.4) * plan.clash));
        }
        else if (plan.clash === 0) add('no vocal clash', 0.2);
      }
      const g = cosine(cur.a.rhythm, t.a.rhythm);
      if (g != null) add('groove match', 1.0 * (g - 0.75));
    }
    if (s.theme && t.a && t.a.style) {
      const dd = dist(s.theme, t.a.style);
      // genre continuity matters on the dance floor; for listening modes it mostly measures recording quality
      if (dd != null) add('style continuity', -(mode.beatmatch ? 0.15 : 0.05) * dd);
    }
    const total = Object.values(parts).reduce((a, v) => a + v, 0);
    return { total, parts, plan };
  }

  function pick(pool, s, exclude) {
    const scored = [];
    for (const t of pool) {
      if (exclude && exclude.has(t.id)) continue;
      const sc = score(t, s);
      if (sc != null) scored.push([sc, t]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, 5);
    if (!top.length) return null;
    // weighted pick among the best few
    const w = top.map(([sc]) => Math.exp((sc - top[0][0]) * 3));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < top.length; i++) { r -= w[i]; if (r <= 0) return top[i][1]; }
    return top[0][1];
  }

  function rankList(pool, s, n) {
    return pool.map(t => [score(t, s), t]).filter(x => x[0] != null).sort((a, b) => b[0] - a[0]).slice(0, n).map(x => x[1]);
  }

  root.DJBrain = {
    MODES, LANGS, queriesFor, detectLanguage, energyOf, moodOf, metaEnergy, noteAnalysed,
    keyCompat, camelot, tempoRatio, bpmOf, pick, rankList, score, scoreDetail, transitionScore, popularity, versionOf, credited, keyOf, langInfo, langAllowed, favLang,
  };
})(window);
