import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { localTimeString } from '../guardrails.js';

const playbookPath = fileURLToPath(new URL('../../playbook/setter-playbook.md', import.meta.url));
const loadPlaybook = () => { try { return readFileSync(playbookPath, 'utf8'); } catch { return ''; } };

function listingFacts(listing) {
  if (!listing) return 'No listing matched. Do not state any property facts; offer a call with Pierce.';
  const f = {
    name: listing.name, city: listing.city, status: listing.status, asking_price: listing.asking_price,
    spaces: listing.spaces, summary: listing.summary, ca_link: listing.ca_link, listing_hub: listing.hub_url,
    crexi: listing.crexi_url, ...listing.facts,
  };
  const lines = Object.entries(f).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  const dns = listing.do_not_share ? `\nDO NOT SHARE (internal only): ${listing.do_not_share}` : '';
  return lines.join('\n') + dns;
}

export function buildSystemPrompt({ lead, listing, mode, kb = [], openQuestions = [] }) {
  const disclosure = config.discloseAi
    ? `You are ${config.owner.name}'s AI assistant at ${config.company}. You are open about being an AI if asked.`
    : `You text on behalf of ${config.owner.name} at ${config.company}. Never claim to be human; if asked, say you're his AI assistant.`;

  return `${disclosure}
You are texting (SMS) with a commercial real estate lead about mobile home park / RV park listings.
Current local time: ${localTimeString()} (${config.timezone}).
Pierce's call windows: ${config.callWindows}.
Booking link: ${config.bookingLink || '(none configured; propose two specific times inside the call windows)'}

# Playbook
${loadPlaybook()}

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

# Lead record
- name: ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'unknown'}
- company: ${lead.company || 'unknown'}; role: ${lead.role || 'unknown'}
- source: ${lead.source}; platform: ${lead.platform || 'unknown'}; property asked about: ${lead.property_name || 'unknown'}
- original inquiry: ${lead.inquiry || 'n/a'}
- channel: ${lead.preferred_channel || 'sms'}
- qualification so far: ${JSON.stringify(lead.qualification || {})}
- status: ${lead.status}

# Output rules
- Finish by calling setter_decision. reply_text is the exact ${lead.preferred_channel === 'email' ? 'email body: plain text, short paragraphs, no signature (one is added)' : 'SMS: plain text, under 300 characters, no markdown, no signature'}.
- ${mode === 'followup' ? 'MODE=FOLLOWUP: the lead has not replied to our last message. Write the next follow-up per the cadence. Do not repeat earlier wording.' : 'MODE=REPLY: respond to the lead\'s latest message.'}
- action "booked" only when the lead confirms a specific day/time or says they booked via the link. Put the time in qualification.call_time.
- action "escalate" for negotiation, terms, commission/co-broke, legal, angry leads, or anything you're not sure about. Draft a safe holding reply anyway; Pierce reviews it.
- action "disqualify" if they're clearly not a buyer (vendor, spam, just browsing and says so). Reply politely or leave reply_text empty.
- action "ask_pierce" when you can't answer from facts/docs/approved answers: put the lead's exact question in question_for_pierce and a short, natural holding reply in reply_text (e.g. "Good question, let me confirm that with Pierce and get right back to you."). Don't send a holding reply if one is already pending (see OPEN QUESTIONS).
- action "no_reply" if nothing needs saying (e.g. "thanks", "ok", a thumbs-up after the call is booked).`;
}

export function buildTranscript(messages) {
  if (!messages.length) return '(no messages yet)';
  return messages.map((m) => `[${m.direction === 'in' ? 'LEAD' : 'US'} ${new Date(m.created_at).toISOString().slice(0, 16)}] ${m.body}`).join('\n');
}

export const SETTER_TOOL = {
  name: 'setter_decision',
  description: 'Decide the next SMS and update the lead record.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['reply', 'send_booking_link', 'booked', 'escalate', 'disqualify', 'ask_pierce', 'no_reply'] },
      reply_text: { type: 'string', description: 'Exact SMS text to send. Empty if action is no_reply.' },
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
      is_lead: { type: 'boolean', description: 'False for marketing emails, digests, or anything that is not a single buyer inquiry.' },
      first_name: { type: 'string' }, last_name: { type: 'string' },
      email: { type: 'string' }, phone: { type: 'string' }, company: { type: 'string' },
      role: { type: 'string', description: 'Industry role if shown (investor, broker, etc.)' },
      property_name: { type: 'string', description: 'The listing they inquired on' },
      action_taken: { type: 'string', description: 'e.g. requested info, downloaded OM, signed CA, called' },
      inquiry_message: { type: 'string', description: 'Their message, verbatim, if any' },
    },
    required: ['is_lead'],
  },
};
