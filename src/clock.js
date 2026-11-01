// Tiny clock wrapper so tests can control "now".
let override = null;
export const now = () => (override ? new Date(override) : new Date());
export const setNow = (d) => { override = d ? new Date(d).toISOString() : null; };
export const hoursSince = (iso) => (iso ? (now() - new Date(iso)) / 36e5 : Infinity);
