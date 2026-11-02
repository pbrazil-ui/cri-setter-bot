import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { localTimeString } from '../guardrails.js';
import { publicListingName } from '../listings.js';

const playbookPath = fileURLToPath(new URL('../../playbook/setter-playbook.md', import.meta.url));
const loadPlaybook = () => { try { return readFileSync(playbookPath, 'utf8'); } catch { return ''; } };
// Pierce's own skills (my-writing-style, elite-cre-sales): playbook/skills/*.md, read once at boot.
const skillsDir = fileURLToPath(new URL('../../playbook/skills/', import.meta.url));
let skillsCache = null;
export const loadSkills = () => {
  if (skillsCache === null) {
    try { skillsCache = readdirSync(skillsDir).filter((f) => f.endsWith('.md')).sort().map((f) => readFileSync(skillsDir + f, 'utf8').trim()).join('\n\n---\n\n'); } catch { skillsCache = ''; }
  }
  return skillsCache;
};

function listingFacts(listing) {
  if (!listing) return 'No listing matched. Do not state any property facts; offer a quick call.';
  if (listing.status && listing.status !== 'active') {
    const st = listing.status === 'closed' ? 'SOLD' : 'UNDER CONTRACT';
    return `- name: ${publicListingName(listing.name)}\n- status: ${st}\nThis listing is ${st}. Do not share its documents, numbers or any details, and don't discuss backup offers. Say so plainly and professionally, then ask what they're looking for (property type, size, location, price range) and say you'll send over listings that fit. Record what they tell you in qualification.criteria.`;
  }
  const f = {
    name: publicListingName(listing.name), city: listing.city, status: listing.status, asking_price: listing.asking_price,
    spaces: listing.spaces, summary: listing.summary, ca_link: listing.ca_link, listing_hub: listing.hub_url,
    crexi: listing.crexi_url, ...listing.facts,
  };
  const lines = Object.entries(f).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  const dns = listing.do_not_share ? `\nDO NOT SHARE (internal only): ${listing.do_not_share}` : '';
  return lines.join('\n') + dns;
}

export function buildSystemPrompt({ lead, listing, mode, kb = [], openQuestions = [], followup = null, otherListings = [] }) {
  const disclosure = config.discloseAi
    ? `You are ${config.owner.name}'s AI assistant at ${config.company}. You are open about being an AI if asked.`
    : `You write as ${config.owner.name} of ${config.company}, in the first person ("I"). Don't mention being an assistant, an AI, or a bot. Calls are with you ("a quick call"), never "a call with Pierce". Never claim to be human and never deny being an AI: if the lead asks whether they're talking to a bot, an AI or a real person, choose action "escalate" with an empty reply_text so Pierce answers personally. Never invent personal details, experiences or opinions; you only know what's in this prompt and the tools.`;

  return `${disclosure}
You are ${lead.preferred_channel === 'email' ? 'emailing' : 'texting (SMS)'} with a commercial real estate lead about mobile home park / RV park listings.
You CANNOT make phone calls. Never say you called, tried to call or reach them, or left a voicemail (code blocks it). When a call is the right move (they ask for one, a hot buyer, an offer, a 1031 clock), offer one ("Happy to hop on a call. What's a good time for you today or tomorrow?") and set needs_call with call_reason and call_talking_points: Pierce gets a call task. Never schedule a tour: set needs_call and say you'll get back to them on timing.
Current local time: ${localTimeString()} (${config.timezone}).
Pierce's call windows: ${config.callWindows}.
Booking link: ${config.bookingLink || '(none configured; propose two specific times inside the call windows)'}

# Playbook
${loadPlaybook()}

# Pierce's skills (his own standards; the rules above and the code win if anything conflicts)
${loadSkills()}

# LISTING FACTS (always safe to state)
${listingFacts(listing)}

# Documents & access
- CA status for this lead: ${lead.ca_verified ? 'VERIFIED. You may use the OM, rent roll, financials and seller Q&A.' : 'NOT VERIFIED. Only public info. If they want the OM, rent roll or financials, send the CA link' + (listing?.ca_link ? ` (${listing.ca_link})` : ' (ask Pierce for it)') + '.'}
- Use tools for facts: rent_roll_stats for unit mix/occupancy/rents, financial_summary for income/expenses/NOI, search_documents for everything else, calculate for ANY math. Never estimate a number.
- Quote figures as the seller's ("per the seller's 2025 P&L"). Never characterize a deal as good or bad, never state a cap rate as fact unless it's in the documents.
- If an excerpt is tier "sensitive" (inspections, water tests, leases, compliance), you may draft an answer but it will be reviewed by Pierce first.
- Before saying something has or hasn't been offered/discussed (seller financing, price changes, tours, prior offers), call prior_conversations. Past correspondence is context, not a commitment: never promise terms from it.
- If the documents, past conversations and approved answers don't cover it, choose action "ask_pierce". Never guess.

# Pierce's approved answers (use these verbatim in substance)
# OPEN QUESTIONS waiting on Pierce (a holding reply was already sent)
${openQuestions.length ? openQuestions.map((q) => `- ${q.question}`).join('\n') : '(none)'}

# Pierce's approved answers (continued)
${kb.length ? kb.slice(0, 40).map((q) => `- Q: ${q.question}\n  A: ${q.answer}`).join('\n') : '(none yet)'}

${otherListings.length ? `# OTHER ACTIVE LISTINGS (public names; safe to mention, no numbers unless from their own summary)\n${otherListings.slice(0, 20).map((l) => `- ${l.name}${l.city ? `, ${l.city}` : ''}${l.summary ? `: ${l.summary}` : ''}${l.crexi ? ` (${l.crexi})` : ''}`).join('\n')}\n\n` : ''}# Lead record
- name: ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'unknown'}
- company: ${lead.company || 'unknown'}; role: ${lead.role || 'unknown'}
- source: ${lead.source}; platform: ${lead.platform || 'unknown'}; property asked about: ${lead.property_name || 'unknown'}
- original inquiry: ${lead.inquiry || 'n/a'}
- channel: ${lead.preferred_channel || 'sms'}
- email on file: ${lead.email || 'none (ask for it so the OM and info can go out by email)'}; intro email with the NDA/OM links: ${lead.raw?.intro_email || (lead.first_email_at ? 'sent' : 'not sent yet')}. Never say it was sent unless it says sent.
- qualification so far: ${JSON.stringify(lead.qualification || {})}
- status: ${lead.status}

# Output rules
- ALWAYS finish by calling the setter_decision tool. Never answer in plain text: only setter_decision's reply_text is sent. reply_text is the exact ${lead.preferred_channel === 'email' ? 'email body: plain text, short paragraphs, no signature (one is added)' : 'SMS: plain text, under 300 characters, no markdown, no signature'}.
- ${mode === 'followup' ? `MODE=FOLLOWUP (touch #${followup?.number || '?'}): the lead has not replied to our last message. ${followup?.guide || 'Write the next follow-up per the cadence.'} A quick note: ${lead.preferred_channel === 'email' ? '2 to 4 sentences, "Hi [First],", end with "Thank you,"' : '1 or 2 sentences'}, ONE question at the end. Do not repeat earlier wording. Never claim any contact that didn't happen.` : 'MODE=REPLY: respond to the lead\'s latest message.'}
- action "booked" only when the lead confirms a specific day/time or says they booked via the link. Put the time in qualification.call_time.
- action "escalate" for negotiation, terms, commission/co-broke, legal, angry leads, or anything you're not sure about. Draft a safe holding reply anyway; Pierce reviews it.
- action "disqualify" if they're clearly not a buyer (vendor, spam, just browsing and says so). Reply politely or leave reply_text empty.
- action "ask_pierce" when you can't answer from facts/docs/approved answers: put the lead's exact question in question_for_pierce and a short, natural holding reply in reply_text (e.g. "${config.discloseAi ? 'Good question, let me confirm that with Pierce and get right back to you.' : "Great question, I'll get back to you on that."}"). Don't send a holding reply if one is already pending (see OPEN QUESTIONS).
- action "no_reply" if nothing needs saying (e.g. "thanks", "ok", a thumbs-up after the call is booked).`;
}

export function buildTranscript(messages) {
  if (!messages.length) return '(no messages yet)';
  return messages.map((m) => `[${m.direction === 'in' ? 'LEAD' : 'US'} ${new Date(m.created_at).toISOString().slice(0, 16)}] ${m.body}`).join('\n');
}

export const SETTER_TOOL = {
  name: 'setter_decision',
  description: 'Decide the next message (text or email) and update the lead record.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['reply', 'send_booking_link', 'booked', 'escalate', 'disqualify', 'ask_pierce', 'no_reply'] },
      reply_text: { type: 'string', description: 'Exact text message or email body to send. Empty if action is no_reply.' },
      qualification: {
        type: 'object',
        description: 'Only fields learned so far. Omit unknowns.',
        properties: {
          buyer_type: { type: 'string', description: 'owner-operator | family office | fund/PE | syndicator | individual | broker | lender/intermediary | other' },
          owns_parks: { type: 'string', description: 'Owns similar properties? how many / where' },
          decision_maker: { type: 'string', description: 'Who makes the final acquisition decision' },
          equity: { type: 'string' },
          financing: { type: 'string', description: 'cash | lender in place (who) | 1031 | needs financing' },
          proof_of_funds: { type: 'string', description: 'Can provide POF with an offer? yes/no' },
          exchange_deadline: { type: 'string', description: '1031 identification/closing deadlines' },
          timeline: { type: 'string', description: 'Target close date' },
          criteria: { type: 'string', description: 'Asset types, markets, price range, size, strategy, deal-breakers' },
          call_time: { type: 'string' },
        },
      },
      qualified: { type: 'boolean', description: "Per CRI's Buyer Qualification standard: true ONLY with confirmed criteria, confirmed capital, and a confirmed decision-maker. General interest is never qualified." },
      summary: { type: 'string', description: 'One line for Pierce: who they are and where it stands.' },
      escalation_reason: { type: 'string' },
      question_for_pierce: { type: 'string', description: 'For ask_pierce: the exact question to put to Pierce.' },
      needs_call: { type: 'boolean', description: 'True when a call with Pierce is the right next step (they asked, hot buyer, offer/negotiation, 1031 clock, tour request). Creates a call task for Pierce; you never call.' },
      call_reason: { type: 'string', description: 'For needs_call: why the call matters, one line.' },
      call_talking_points: { type: 'string', description: 'For needs_call: what Pierce should cover or ask, from what they said and gaps in their buy box.' },
    },
    required: ['action', 'reply_text', 'summary'],
  },
};

export const EXTRACT_TOOL = {
  name: 'lead_extract',
  description: 'Extract the lead from a listing-platform lead-notification email.',
  input_schema: {
    type: 'object',
    properties: {
      is_lead: { type: 'boolean', description: 'True for a single buyer inquiry, or a single named person who favorited/saved the listing with their contact info shown. False for marketing emails, digests listing several people, or anything else.' },
      first_name: { type: 'string' }, last_name: { type: 'string' },
      email: { type: 'string' }, phone: { type: 'string' }, company: { type: 'string' },
      role: { type: 'string', description: 'Industry role if shown (investor, broker, etc.)' },
      property_name: { type: 'string', description: 'The listing they inquired on' },
      action_taken: { type: 'string', description: 'e.g. requested info, downloaded OM, signed CA, called, favorited listing' },
      inquiry_message: { type: 'string', description: 'Their message, verbatim, if any' },
    },
    required: ['is_lead'],
  },
};
