import { config } from './config.js';
import { buildSystemPrompt, buildTranscript, SETTER_TOOL, EXTRACT_TOOL } from './agent/prompt.js';
import { AGENT_TOOLS } from './agent/tools.js';

let client = null;
async function getClient() {
  if (!client) { const { default: Anthropic } = await import('@anthropic-ai/sdk'); client = new Anthropic({ apiKey: config.anthropic.apiKey }); }
  return client;
}

// Current models (Claude Sonnet 5.5 / Opus 5.5) reject forced tool_choice ("tool"/"any") with a 400, so:
//  - one-shot extraction uses structured outputs (output_config.format, a JSON schema) -> guaranteed parseable JSON
//  - the setter agent loop uses tool_choice auto + strict tools + a prompt instruction, and re-prompts if no decision
// Thinking is adaptive by default on these models and its tokens count toward max_tokens, so budgets are generous.

/** Deep copy with additionalProperties:false on every object (required by structured outputs / strict tools). */
export function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = (k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictSchema(pv)])) : strictSchema(v));
  if (out.type === 'object') { out.additionalProperties = false; if (!out.properties) out.properties = {}; }
  return out;
}

function checkStop(res, what) {
  if (res.stop_reason === 'refusal') throw new Error(`${what}: Claude declined (${res.stop_details?.category || 'refusal'})`);
  if (res.stop_reason === 'max_tokens') throw new Error(`${what}: hit max_tokens before finishing`);
}

/** One request whose answer must be JSON matching `schema` (structured outputs). Returns the parsed object. */
async function callJson({ model, system, content, schema, maxTokens = 16000, effort, what = 'claude' }) {
  const res = await (await getClient()).messages.create({
    model, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: strictSchema(schema) }, ...(effort ? { effort } : {}) },
  });
  checkStop(res, what);
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { throw new Error(`${what}: response was not valid JSON`); }
}

/**
 * Agent loop: the model may call document/math tools, then must finish with setter_decision.
 * executors = makeExecutors(ctx). tool_choice stays "auto" (forced choice is a 400 on current models): the prompt
 * says to finish with setter_decision, and if a turn ends without it we ask once more. Capped at 6 model calls.
 */
export async function runSetter({ lead, listing, messages, mode = 'reply', executors, kb = [], openQuestions = [], followup = null, otherListings = [] }) {
  if (config.llmMode === 'mock') return mockSetter({ lead, listing, messages, mode, executors, kb, openQuestions, followup });
  const system = buildSystemPrompt({ lead, listing, mode, kb, openQuestions, followup, otherListings });
  const convo = [{ role: 'user', content: `Conversation so far:\n${buildTranscript(messages)}\n\nUse tools if you need facts or math, then call setter_decision.` }];
  const tools = (executors ? [...AGENT_TOOLS, SETTER_TOOL] : [SETTER_TOOL]).map((t) => ({ ...t, input_schema: strictSchema(t.input_schema), strict: true }));
  const MAX = 6;
  for (let step = 0; step < MAX; step++) {
    const res = await (await getClient()).messages.create({
      model: config.anthropic.model, max_tokens: 16000, system, tools, messages: convo,
      ...(config.anthropic.effort ? { output_config: { effort: config.anthropic.effort } } : {}),
    });
    checkStop(res, 'setter');
    const uses = res.content.filter((b) => b.type === 'tool_use');
    const final = uses.find((u) => u.name === SETTER_TOOL.name);
    if (final) return final.input;
    convo.push({ role: 'assistant', content: res.content }); // unchanged, thinking blocks included (append-only)
    if (!uses.length) { // answered in plain text: that text never reaches anyone, so ask for the decision
      convo.push({ role: 'user', content: 'Call the setter_decision tool now with your decision. Plain text is not sent to the lead.' });
      continue;
    }
    convo.push({
      role: 'user',
      content: await Promise.all(uses.map(async (u) => {
        let out;
        try { out = executors[u.name] ? await executors[u.name](u.input || {}) : { error: `unknown tool ${u.name}` }; } catch (e) { out = { error: e.message }; }
        return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) };
      })),
    });
  }
  throw new Error('agent did not finish');
}

const EXTRACT_SYSTEM = `You read commercial real estate due-diligence documents (mobile home parks, RV resorts) for a brokerage.
Extract every concrete fact a buyer might ask about: counts, unit/site mix, rents, fees, occupancy, utilities (water/sewer/electric, who pays, private vs city),
permits, amenities, acreage, expenses, taxes, dates, capital work. Each fact is one standalone sentence naming its subject and source period.
NEVER include tenant names, resident phone numbers, emails, or other personal information.
For rent rolls return every row in rent_roll_rows. For income statements / P&Ls return every line item in financials (expenses as positive numbers, the period, and the months covered).`;

export async function extractDocument({ filename, docType, pdf, text }) {
  if (config.llmMode === 'mock') return mockExtractDoc({ filename, docType, text: text ?? pdf?.toString('utf8') ?? '' });
  const content = pdf
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } }, { type: 'text', text: `File: ${filename} (classified as ${docType}). Extract per instructions.` }]
    : `File: ${filename} (classified as ${docType}).\n\n${text}`;
  const model = ['t12', 'rent_roll', 'om'].includes(docType) ? config.anthropic.model : config.anthropic.extractModel;
  return callJson({ model, system: EXTRACT_SYSTEM, content, schema: DOC_TOOL.input_schema, maxTokens: 16000, effort: config.anthropic.extractEffort, what: `extract ${filename}` });
}

/** Turn Pierce's quick answer into a reply to the lead, using only his facts. */
export const mockLlm = { failPolish: false }; // LLM_MODE=mock only: tests make polishAnswer throw
export async function polishAnswer({ lead, question, answer }) {
  if (config.llmMode === 'mock') { if (mockLlm.failPolish) throw new Error('mock LLM failure'); return `Confirmed: ${answer}`; }
  const r = await callJson({
    model: config.anthropic.model, effort: 'low', maxTokens: 4000, what: 'polish answer',
    system: `Rewrite the broker's answer as a short, natural ${lead.preferred_channel === 'email' ? 'email reply (no signature)' : 'text message (under 300 characters)'} to the lead.${config.discloseAi ? '' : ' Write as the broker himself, first person.'} Use ONLY facts in the broker's answer. Don't add claims, numbers, or enthusiasm.`,
    content: `Lead asked: ${question}\nPierce's answer: ${answer}`,
    schema: { type: 'object', properties: { text: { type: 'string', description: 'The reply' } }, required: ['text'] },
  });
  return r.text;
}

export async function extractLeadFromEmail({ subject, text }) {
  if (config.llmMode === 'mock') return mockExtract({ subject, text });
  return callJson({
    model: config.anthropic.extractModel, effort: 'low', maxTokens: 4000, what: 'extract lead',
    system: 'You extract structured lead data from commercial real estate listing-platform lead notifications (Crexi, LoopNet, RVParkStore, MHVillage, website forms), sometimes forwarded. The lead is the person who inquired, never the broker or the platform. Return only what is in the email. Never guess phone numbers or emails.',
    content: `Subject: ${subject}\n\n${text}`,
    schema: EXTRACT_TOOL.input_schema,
  });
}

const DOC_TOOL = {
  name: 'doc_extract',
  description: 'Structured extraction of one document.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '1-3 sentences: what this document is and covers.' },
      facts: { type: 'array', items: { type: 'string' } },
      rent_roll_rows: { type: 'array', items: { type: 'object', properties: { space: { type: 'string' }, type: { type: 'string' }, ownership: { type: 'string' }, status: { type: 'string' }, rent: { type: 'number' } } } },
      financials: {
        type: 'object',
        properties: {
          period: { type: 'string' }, months: { type: 'number' },
          income: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'number' } } } },
          expenses: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, amount: { type: 'number' } } } },
          reported: { type: 'object', properties: { total_income: { type: 'number' }, total_expenses: { type: 'number' }, noi: { type: 'number' } } },
        },
      },
    },
    required: ['summary', 'facts'],
  },
};

// ---------- deterministic mocks for local dev + tests ----------
function mockExtractDoc({ docType, text }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { summary: lines[0] || '', facts: lines };
  if (docType === 't12') {
    let section = null; const fin = { period: lines[0], months: 12, income: [], expenses: [], reported: {} };
    for (const l of lines) {
      if (/^income/i.test(l)) { section = 'income'; continue; }
      if (/^expenses?/i.test(l)) { section = 'expenses'; continue; }
      const m = l.match(/^(.+?):\s*\$?([\d,.]+)/); if (!m) continue;
      const amt = Number(m[2].replace(/,/g, ''));
      if (/^total income/i.test(m[1])) fin.reported.total_income = amt;
      else if (/^total expenses/i.test(m[1])) fin.reported.total_expenses = amt;
      else if (/^noi|net operating/i.test(m[1])) fin.reported.noi = amt;
      else if (section) fin[section].push({ label: m[1], amount: amt });
    }
    out.financials = fin;
  }
  return out;
}

const overlap = (a, b) => {
  const t = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const A = t(a); const B = t(b); return [...A].filter((w) => B.has(w)).length / Math.max(1, Math.min(A.size, B.size));
};

async function mockSetter({ lead, listing, messages, mode, executors, kb, openQuestions, followup }) {
  const lastOut = [...messages].reverse().findIndex((m) => m.direction === 'out');
  const pending = (lastOut === -1 ? messages : messages.slice(messages.length - lastOut)).filter((m) => m.direction === 'in');
  const last = pending.map((m) => m.body).join(' ').toLowerCase() || [...messages].reverse().find((m) => m.direction === 'in')?.body?.toLowerCase() || '';
  if (/are you (a |an )?(bot|ai|real)|is this (a |an )?(bot|real person)/.test(last)) return { action: 'escalate', reply_text: '', escalation_reason: 'asked if bot', summary: 'Asked whether this is a bot' };
  if (listing && listing.status && listing.status !== 'active' && mode !== 'followup') {
    const sold = listing.status === 'closed';
    if (/looking for|want|need|\d+\s*(spaces|units|sites|pads)|\$\d/.test(last)) return { action: 'reply', reply_text: "Got it, I'll send over anything that fits.", qualification: { criteria: last }, summary: `Criteria (${sold ? 'sold' : 'under-contract'} listing inquiry)` };
    return { action: 'reply', reply_text: `That one is ${sold ? 'sold' : 'under contract'}, but I have other listings I can share. What are you looking for?`, summary: 'Off-market listing; asked criteria' };
  }
  if (mode === 'followup' && followup?.step === 'nurture') return { action: 'reply', reply_text: `Hi${lead.first_name ? ` ${lead.first_name}` : ''}, are you still looking for MH or RV parks?`, summary: 'nurture' };
  if (mode === 'followup' && followup?.step === 'value_touch' && executors) {
    const past = await executors.prior_conversations({ topic: 'seller financing' }); // the value touch may draw on history
    if (past.results?.length) return { action: 'reply', reply_text: `Quick note on financing: ${past.results[0].excerpt.split('\n').pop().slice(0, 160)}`, summary: 'day 3 from history' };
  }
  if (mode === 'followup' && followup?.step === 'still_looking') return { action: 'reply', reply_text: 'Still in the market for parks in NorCal?', summary: 'day 7' };
  if (mode !== 'followup' && /\b(call me|give me a call|hop on a call|can we talk|phone call)\b/.test(last)) return { action: 'reply', reply_text: "Happy to hop on a call. What's a good time for you today or tomorrow?", needs_call: true, call_reason: 'asked for a call', summary: 'Wants a call' };
  if (mode === 'followup') return { action: 'reply', reply_text: lead.status === 'in_dd' ? 'Had a chance to go through the numbers? Happy to walk through anything.' : 'Quick follow-up: still worth a short call this week?', summary: 'follow-up' };
  if (/tuesday|monday|wednesday|thursday|friday|\d(am|pm)/.test(last)) return { action: 'booked', reply_text: "Perfect, I'll call you then.", qualification: { call_time: last }, qualified: true, summary: 'Call booked' };
  if (/not interested|no thanks/.test(last)) return { action: 'disqualify', reply_text: 'Understood, thanks for letting me know.', summary: 'Not interested' };
  if (/offer|price/.test(last)) return { action: 'escalate', reply_text: "Good question, let me get back to you on that directly.", escalation_reason: 'price/offer', summary: 'Asking about price' };
  if (/cash|1031|bank/.test(last)) return { action: 'send_booking_link', reply_text: 'Great. Easiest next step is a quick 15-min call. What day works?', qualification: { financing: last }, qualified: true, summary: 'Qualified buyer' };
  if (executors && /unit mix|how many|\brv\b|\bmh\b|occupan/.test(last)) {
    const s = await executors.rent_roll_stats({});
    if (s.locked) return { action: 'reply', reply_text: `That's in the rent roll, which opens up once the CA is signed: ${s.ca_link || '(CA link)'}`, summary: 'Asked unit mix pre-CA' };
    if (!s.available) return { action: 'ask_pierce', question_for_pierce: last, reply_text: "Great question, I'll get back to you on that.", summary: 'no rent roll' };
    const parts = Object.entries(s.by_type).map(([t, g]) => `${g.spaces} ${t} (${g.occupied} occupied, avg $${g.avg_rent_occupied})`);
    return { action: 'reply', reply_text: `Per the rent roll: ${s.total.spaces} spaces, ${parts.join(', ')}. ${s.total.occupancy_pct}% occupied overall.`, summary: 'Answered unit mix' };
  }
  if (executors && /\bnoi\b|income|expenses/.test(last)) {
    const f = await executors.financial_summary({});
    if (f.locked) return { action: 'reply', reply_text: `Financials open up after the CA: ${f.ca_link}`, summary: 'pre-CA' };
    const st = f.statements?.[0];
    if (st) return { action: 'reply', reply_text: `Per the seller's ${st.period}: income $${st.total_income}, expenses $${st.total_expenses}, NOI $${st.noi}.`, summary: 'Answered NOI' };
  }
  if (executors && /send|\bom\b|offering/.test(last)) {
    const docs = await executors.list_documents({});
    const om = docs.documents.find((d) => d.type === 'om');
    if (!om) return { action: 'reply', reply_text: `Happy to. First step is the CA: ${docs.ca_link}`, summary: 'OM request pre-CA' };
    const link = await executors.get_document_link({ document_id: om.id });
    return { action: 'reply', reply_text: link.ok ? `Here's the OM: ${link.url}` : "I'll email that over shortly.", summary: 'Sent OM' };
  }
  const kbHit = kb.find((q) => overlap(q.question, last) >= 0.5);
  if (kbHit) return { action: 'reply', reply_text: kbHit.answer, summary: 'Answered from approved answers' };
  if (executors && last.includes('?')) {
    const r = await executors.search_documents({ query: last });
    const best = (r.results || []).map((x) => ({ x, o: overlap(x.excerpt, last) })).sort((a, b) => b.o - a.o)[0];
    if (best && best.o >= 0.4) return { action: 'reply', reply_text: `Per ${best.x.file}: ${best.x.excerpt.split('\n').slice(1).join(' ').slice(0, 200)}`, summary: 'Answered from docs' };
    if (openQuestions.length) return { action: 'no_reply', reply_text: '', summary: 'waiting on Pierce' };
    return { action: 'ask_pierce', question_for_pierce: pending.map((m) => m.body).join(' / '), reply_text: "Great question, I'll get back to you on that.", summary: 'Needs Pierce' };
  }
  if (/thanks|ok\b|👍/.test(last)) return { action: 'no_reply', reply_text: '', summary: 'ack' };
  return { action: 'reply', reply_text: 'Thanks! How are you planning to fund it: cash, bank debt, or a 1031?', summary: 'Engaged' };
}

function mockExtract({ subject, text }) {
  const body = `${subject}\n${text}`;
  const email = body.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  const phone = body.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0];
  const name = body.match(/^\s*Name[:\t ]+([^\n]+)/im)?.[1]?.trim().split(/\s+/) || [];
  const property = body.match(/(?:Property|Listing):\s*([^\n]+)/i)?.[1]?.trim() || body.match(/contacted you for ([^\n]+)/i)?.[1]?.trim();
  return { is_lead: !!(email || phone), first_name: name[0], last_name: name.slice(1).join(' ') || undefined, email, phone, property_name: property, inquiry_message: body.match(/Message:\s*([^\n]+)/i)?.[1] || body.match(/Wrote:\s*\n+([^\n]+)/i)?.[1] };
}
