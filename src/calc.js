// Safe arithmetic for the agent: + - * / ^ % ( ) and decimals. No eval.
export function calculate(expr) {
  const s = String(expr).replace(/[$,\s]/g, '');
  let i = 0;
  const peek = () => s[i];
  const num = () => {
    const m = s.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/i);
    if (!m) throw new Error(`bad number at ${i}`);
    i += m[0].length;
    let v = Number(m[0]);
    if (peek() === '%') { i++; v /= 100; }
    return v;
  };
  const factor = () => {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr0(); if (s[i++] !== ')') throw new Error('missing )'); return v; }
    return num();
  };
  const power = () => { let v = factor(); while (peek() === '^') { i++; v **= factor(); } return v; };
  const term = () => {
    let v = power();
    while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = power(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const expr0 = () => {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const v = expr0();
  if (i !== s.length) throw new Error(`unexpected "${s[i]}"`);
  if (!Number.isFinite(v)) throw new Error('not a finite number');
  return Math.round(v * 1e6) / 1e6;
}
