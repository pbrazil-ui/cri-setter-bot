// Hard rules enforced in code, never left to the model.
import { config } from './config.js';
import { now } from './clock.js';

export function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (String(raw).trim().startsWith('+') && d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
}

const STOP_KEYWORDS = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out', 'opt-out']);
const STOP_PHRASES = /\b(stop (texting|messaging|contacting)|remove me|take me off|do not (text|contact|message)|don'?t (text|contact|message)|unsubscribe|lose my number|delete my number|leave me alone)\b/i;
const WRONG_NUMBER = /\b(wrong (number|person)|who is this\?? i (never|didn'?t))\b/i;

/** 'keyword' = carrier STOP word (carrier/RingCentral sends its own confirmation), 'phrase' = natural language, 'wrong_number' */
export function optOutIntent(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!\s]+$/, '');
  if (STOP_KEYWORDS.has(t)) return 'keyword';
  if (WRONG_NUMBER.test(text)) return 'wrong_number';
  if (STOP_PHRASES.test(text)) return 'phrase';
  return null;
}

export const isStartKeyword = (text) => /^\s*(start|unstop)\s*$/i.test(String(text || ''));

// Anything touching price negotiation, terms, contracts, or legal goes to Pierce before a reply is sent.
const HUMAN_TOPICS = /\b(offer|loi|letter of intent|counter|best (and final|price)|lowest|bottom line|take less|discount|seller (carry|financ\w*)|owner (carry|financ\w*)|carry back|terms|cap rate is wrong|attorney|lawyer|lawsuit|sue|complain\w*|escrow|contract|commission|co-?broke|referral fee|buyer'?s? broker|exclusive)\b/i;
// "Is this a bot?" Pierce answers that himself; the bot never claims to be human and never denies being AI.
const IDENTITY_QUESTION = /\b(are you (an? )?(bot|robot|ai|a\.i\.|real( person)?|human|automated|computer)|is this (an? )?(bot|robot|ai|automated|real person|computer|recording)|am i (talking|texting|speaking|chatting) (to|with) (an? )?(bot|robot|ai|real person|human|person|computer)|chat ?gpt|artificial intelligence)\b/i;
export const asksIfBot = (text) => IDENTITY_QUESTION.test(String(text || ''));
// Tours: Pierce's skill says never schedule them; flag to Pierce.
const TOUR = /\b(tour|site visit|walk (the )?(park|property|site)|see (the )?(park|property) in person|come (out|by) and see|visit the (park|property))\b/i;
export const asksForTour = (text) => TOUR.test(String(text || ''));
export const needsHuman = (text) => HUMAN_TOPICS.test(String(text || '')) || asksIfBot(text) || asksForTour(text);

// The bot can't call. A message that says Pierce called, tried to, or left a voicemail would be false.
const CONTACT_CLAIM = /\b(tried (calling|to call|to reach|reaching|to get a hold of|to catch)|(i |just )(called|rang|phoned)( you)?|gave you a (call|ring)|left (you )?(a )?(voicemail|vm|voice mail|message on your phone)|missed (you|your call)|tried your (cell|phone|line))\b/i;
export const claimsContact = (text) => CONTACT_CLAIM.test(String(text || ''));

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, hour: Number(get('hour')) + Number(get('minute')) / 60 };
}

export function inWindow(win, date = now(), tz = config.timezone) {
  const { day, hour } = localParts(date, tz);
  return win.days.includes(day) && hour >= win.start && hour < win.end;
}

export function nextWindowStart(win, date = now(), tz = config.timezone) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  for (let i = 0; i < 24 * 4 * 8; i++) { // 15-minute steps, up to 8 days
    if (inWindow(win, d, tz)) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 15);
  }
  return d;
}

export function localTimeString(date = now()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

/** Keep SMS short: trim whitespace and hard-cap length (2 segments). */
export function cleanSms(text, max = 320) {
  let t = String(text || '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}
