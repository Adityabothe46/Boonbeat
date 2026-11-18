# Boonbeat

**Your AI DJ, in the browser.** Open it at **https://adityabothe46.github.io/Boonbeat/**

Boonbeat finds party songs, picks what fits the mood, and mixes one into the next the way a real DJ would. Transitions are beat-matched and land on the phrase, and the bass is swapped so two kick drums never clash.

## Use it on your phone
1. Open the link above in Safari (iPhone/iPad) or Chrome (Android).
2. Tap **Share > Add to Home Screen** (iPhone) or **⋮ > Add to Home screen / Install app** (Android).
3. Open Boonbeat from your home screen, pick a mode and a language, and tap **Start the party**.

Keep Boonbeat open on screen during a set. It keeps the screen awake by itself, because phones pause web apps in the background.

## What it does
- **Modes:** Dance Floor, Warm Up, Romantic and Chill, each with its own energy curve.
- **Languages:** Hindi, Punjabi, Hindi + Punjabi, English or a mix.
- **Song analysis:** every song is analysed for tempo, beat grid, downbeats, sections (intro, drop, breakdown, outro) and musical key. Small AI models also score how danceable, party-ready and vocal it is.
- **Mixing:** two decks with tempo matching, phase lock, EQ bass swaps, filter sweeps and echo-outs, timed to the structure of both songs.
- **Your taste:** a favourite-songs list plays first, and 👍 / 👎 teach it what you like. Everything stays on your device.

## Where the music comes from
All free, full-length songs from public APIs:
- **[Audius](https://audius.co):** official releases from verified artists and labels (Disclosure, Dirtybird, Anjunadeep, bitbird, Black Hole Recordings and more), plus community uploads.
- **[hearthis.at](https://hearthis.at):** lots of Bollywood and Punjabi DJ edits.
- **[Internet Archive netlabels](https://archive.org/details/netlabels):** Creative Commons electronic and dance releases.

## Run it locally
It's plain HTML and JavaScript with no build step. Serve the folder with any static server, then open http://localhost:8765:

    python -m http.server 8765

## Credits
Song analysis models (MusiCNN) by the [Music Technology Group, Universitat Pompeu Fabra](https://essentia.upf.edu/models.html), licensed CC BY-NC-ND 4.0. See `models/LICENSE.txt`. Because of that license, Boonbeat is for personal, non-commercial use.
