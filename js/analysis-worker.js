/* Runs the beat, key and structure analysis off the main thread, so the music and the mixer never
   stall while Boonbeat studies the next songs (phones would otherwise freeze for seconds at a time). */
importScripts('analysis.js?v=24');
self.onmessage = e => {
  const { id, ch, sr, hint } = e.data;
  try { self.postMessage({ id, a: self.DJAnalysis.analyzeSamples(ch, sr, hint) }); }
  catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
