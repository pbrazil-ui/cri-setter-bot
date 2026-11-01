// Small keyword search over document chunks. Listing doc sets are small enough that this beats
// running a vector DB; swap for pgvector later if recall becomes a problem.
const STOP = new Set('the a an of and or to in on for is are was were be it this that with what how many much does do any there their at by from as'.split(' '));
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9$.%\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

const SYN = { quality: ['quality', 'coliform', 'lab', 'test', 'bacteria'], issues: ['issues', 'violation', 'violations', 'fail', 'problem'], rv: ['rv', 'rvs', 'recreational'], mh: ['mh', 'mobile', 'manufactured', 'homes'], water: ['water', 'well', 'wells', 'potable'], sewer: ['sewer', 'septic'], noi: ['noi', 'net', 'operating', 'income'], taxes: ['tax', 'taxes', 'property'] };
const expand = (ts) => ts.flatMap((t) => SYN[t] || [t]);

export function chunkText(text, size = 1200, overlap = 150) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const out = [];
  for (let i = 0; i < clean.length; i += size - overlap) out.push(clean.slice(i, i + size));
  return out;
}

export function searchChunks(chunks, query, k = 5) {
  const q = expand(tokens(query));
  if (!q.length) return [];
  const df = new Map();
  const docs = chunks.map((c) => { const t = new Set(tokens(c.content)); t.forEach((w) => df.set(w, (df.get(w) || 0) + 1)); return t; });
  const N = chunks.length;
  const distinct = new Set(q);
  const rare = (w) => (df.get(w) || 0) <= Math.max(1, Math.ceil(N * 0.15));
  const minMatches = distinct.size >= 2 ? 2 : 1;
  return chunks
    .map((c, i) => {
      const matched = [...distinct].filter((w) => docs[i].has(w));
      return { c, matched: matched.length, rareHit: matched.some(rare), score: matched.reduce((s, w) => s + Math.log(1 + N / (df.get(w) || 1)), 0) };
    })
    .filter((x) => x.matched >= minMatches || (x.matched === 1 && x.rareHit))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}
