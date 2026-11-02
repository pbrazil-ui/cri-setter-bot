// Outbound email through Microsoft Graph (your cribrokerage.com mailbox). Two modes:
//   EMAIL_SEND_MODE=draft  -> creates a Draft in Outlook/Superhuman for you to review and send (default, safest)
//   EMAIL_SEND_MODE=send   -> sends from your mailbox after the bot's normal approval gate
// Signature is NOT added here when drafting: Outlook/Superhuman append yours. In send mode EMAIL_SIGNATURE_HTML is used.
import { config } from './config.js';

export const mockMailbox = []; // EMAIL_MODE=mock (outbound)
export const mockInbox = []; // EMAIL_MODE=mock (inbound): [{ id, conversationId, receivedDateTime, from: { emailAddress: { address } }, subject, body: { contentType, content } }]
export const mockSentItems = []; // EMAIL_MODE=mock: what Pierce sent by hand [{ conversationId, sentDateTime }]

const E = config.email;
let token = null; let exp = 0;
async function getToken() {
  if (token && Date.now() < exp - 60e3) return token;
  const res = await fetch(`https://login.microsoftonline.com/${E.tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: E.clientId, client_secret: E.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Graph auth ${res.status}: ${await res.text()}`);
  const j = await res.json(); token = j.access_token; exp = Date.now() + j.expires_in * 1000; return token;
}
async function graph(method, path, body) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, { method, headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`Graph ${method} ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 202 || res.status === 204 ? null : res.json();
}

/** Read-only: app credentials work and can open the mailbox's inbox (Mail.ReadWrite). Mail.Send can't be checked without sending. */
export async function mailCheck() {
  if (E.mode !== 'live') return { mode: E.mode };
  const inbox = await graph('GET', `/users/${encodeURIComponent(E.mailbox)}/mailFolders/inbox?$select=displayName,totalItemCount`);
  return { ok: true, mailbox: E.mailbox, inbox_items: inbox.totalItemCount, send_mode: E.sendMode, signature_set: !!E.signatureHtml,
    problems: E.sendMode === 'send' && !E.signatureHtml ? ['EMAIL_SEND_MODE=send but EMAIL_SIGNATURE_HTML is empty: sent emails will end at "Thanks," with no name'] : [] };
}

/** Inbox messages received at/after `sinceIso`, oldest first. Needs Mail.ReadWrite (already required). */
export async function listInboxSince(sinceIso, top = 50) {
  if (E.mode === 'mock') return mockInbox.filter((m) => m.receivedDateTime >= sinceIso).sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime)).slice(0, top);
  const q = new URLSearchParams({ $filter: `receivedDateTime ge ${sinceIso}`, $orderby: 'receivedDateTime asc', $top: String(top), $select: 'id,conversationId,receivedDateTime,from,subject,body' });
  const r = await graph('GET', `/users/${encodeURIComponent(E.mailbox)}/mailFolders/inbox/messages?${q}`);
  return r?.value || [];
}

/** Has anything been sent from the mailbox in this conversation after `sinceIso`? (Pierce answered by hand.) */
export async function sentInConversationSince(conversationId, sinceIso) {
  if (!conversationId) return false;
  if (E.mode === 'mock') return mockSentItems.some((m) => m.conversationId === conversationId && m.sentDateTime > sinceIso);
  if (E.mode !== 'live') return false;
  const q = new URLSearchParams({ $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`, $select: 'sentDateTime', $top: '25' });
  const r = await graph('GET', `/users/${encodeURIComponent(E.mailbox)}/mailFolders/sentitems/messages?${q}`);
  return (r?.value || []).some((m) => m.sentDateTime > sinceIso);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (text) => text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

/**
 * attachments: [{ name, buffer }] (max ~3 MB each via this simple path)
 * Returns { id, mode: 'draft' | 'sent' }.
 */
export async function sendEmail({ to, cc = [], subject, text, attachments = [], inReplyToId = null }) {
  const ccAll = [...new Set([...cc, ...E.alwaysCc].filter(Boolean))];
  if (E.mode === 'mock') { const id = `mail-${mockMailbox.length + 1}`; mockMailbox.push({ id, to, cc: ccAll, subject, text, attachments: attachments.map((a) => a.name), mode: E.sendMode, inReplyToId }); return { id, mode: E.sendMode === 'send' ? 'sent' : 'draft' }; }

  const bodyHtml = toHtml(text) + (E.sendMode === 'send' && E.signatureHtml ? `<br>${E.signatureHtml}` : '');
  const message = {
    subject, body: { contentType: 'HTML', content: bodyHtml },
    toRecipients: [{ emailAddress: { address: to } }],
    ccRecipients: ccAll.map((a) => ({ emailAddress: { address: a } })),
    attachments: attachments.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentBytes: a.buffer.toString('base64') })),
  };
  const base = `/users/${encodeURIComponent(E.mailbox)}`;
  if (inReplyToId) {
    // reply in-thread: create reply draft, patch body/attachments, then send or leave as draft
    const draft = await graph('POST', `${base}/messages/${inReplyToId}/createReply`, {});
    await graph('PATCH', `${base}/messages/${draft.id}`, { body: message.body, ccRecipients: message.ccRecipients });
    for (const a of message.attachments) await graph('POST', `${base}/messages/${draft.id}/attachments`, a);
    if (E.sendMode === 'send') { await graph('POST', `${base}/messages/${draft.id}/send`); return { id: draft.id, mode: 'sent' }; }
    return { id: draft.id, mode: 'draft' };
  }
  if (E.sendMode === 'send') { await graph('POST', `${base}/sendMail`, { message, saveToSentItems: true }); return { id: null, mode: 'sent' }; }
  const draft = await graph('POST', `${base}/messages`, message);
  return { id: draft.id, mode: 'draft' };
}
