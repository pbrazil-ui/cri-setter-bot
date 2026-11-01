import express from 'express';
import multer from 'multer';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { isPaused } from './agent/setter.js';
import { handleRingCentralEvent } from './webhook.js';
import { ingestEmail } from './intake/email.js';
import { importCsv } from './intake/csv.js';
import { upsertIncomingLead } from './intake/common.js';
import { processFirstTouch } from './agent/setter.js';
import { ensureSubscription } from './ringcentral.js';
import { tick, docSync } from './jobs.js';
import { db } from './db/index.js';
import { matchListing } from './listings.js';
import { runSetter } from './llm.js';
import { makeExecutors } from './agent/tools.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function requireKey(req, res, next) {
  const given = Buffer.from(String(req.query.key || req.get('x-ingest-key') || ''));
  const want = Buffer.from(config.ingestSecret || '');
  if (!want.length || given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ error: 'bad key' });
  next();
}

export function buildApp() {
  const app = express();

  app.get('/health', async (_req, res) => res.json({ ok: true, paused: await isPaused(), db: config.dbMode, sms: config.smsMode, llm: config.llmMode }));

  // RingCentral: validation handshake on subscribe, then SMS events
  app.post('/webhooks/ringcentral', express.json({ limit: '1mb' }), (req, res) => {
    const validation = req.get('Validation-Token');
    if (validation) { res.set('Validation-Token', validation); return res.status(200).end(); }
    if (config.rc.verificationToken && req.get('Verification-Token') !== config.rc.verificationToken) return res.status(401).end();
    res.status(200).end(); // ack fast; RingCentral retries slow endpoints
    handleRingCentralEvent(req.body).catch((e) => console.error('[rc event]', e));
  });

  // Crexi lead emails (Postmark inbound JSON, Zapier, Make, etc.)
  app.post('/ingest/email', requireKey, express.json({ limit: '5mb' }), async (req, res) => {
    try { res.json(await ingestEmail(req.body)); } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
  });

  // One structured lead (Zapier, HubSpot workflow webhook, website form, future Crexi integration)
  app.post('/ingest/lead', requireKey, express.json(), async (req, res) => {
    try {
      const r = await upsertIncomingLead(req.body, 'webhook');
      if (r.created || r.reopened) r.firstTouch = await processFirstTouch(r.lead);
      res.json(r);
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
  });

  // Bulk CSV (Crexi Lead Report export). Leads are queued and texted in paced batches.
  app.post('/ingest/csv', requireKey, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'attach a CSV as "file"' });
    try { res.json(await importCsv(req.file.buffer, { defaultProperty: req.body?.property || req.query.property })); } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
  });

  // Phone-friendly upload page
  app.get('/upload', requireKey, (req, res) => {
    res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload leads</title><body style="font-family:system-ui;max-width:480px;margin:40px auto;padding:0 16px">
<h2>Upload a lead CSV</h2><p>Crexi: Lead Activity → Export Lead Report. Leads are queued, then texted in small batches during send hours${config.autoSend.csv ? '' : ' after you approve each one'}.</p>
<form method="post" action="/ingest/csv?key=${encodeURIComponent(req.query.key)}" enctype="multipart/form-data">
<p><input type="file" name="file" accept=".csv" required></p>
<p><input name="property" placeholder="Property (only if the CSV has no property column)" style="width:100%"></p>
<button>Upload</button></form></body>`);
  });

  app.post('/admin/subscribe', requireKey, async (_req, res) => { try { res.json(await ensureSubscription()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/admin/import-email-history', requireKey, async (req, res) => { try { const { importEmailHistory } = await import('./docs/history.js'); res.json(await importEmailHistory({ days: Number(req.query.days) || 365 })); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/admin/sync-docs', requireKey, async (_req, res) => res.json(await docSync()));

  // The document brain, for the Mac mini email agent (or you): answer a buyer question from Dropbox docs.
  // body: { listing: "Lighthouse", question: "...", ca_verified: true|false }
  app.post('/api/ask', requireKey, express.json(), async (req, res) => {
    try {
      const { listing: name, question, ca_verified = false } = req.body || {};
      const listing = await matchListing(name);
      if (!listing) return res.status(404).json({ error: `no listing matches "${name}"` });
      const lead = { id: 0, source: 'api', status: 'engaged', preferred_channel: 'email', ca_verified: !!ca_verified, property_name: listing.name, qualification: {} };
      const ctx = { lead, listing, flags: { usedSensitive: false, links: [], needsAttachment: [] } };
      const d = await runSetter({ lead, listing, messages: [{ direction: 'in', body: question, created_at: new Date().toISOString() }], executors: makeExecutors(ctx), kb: await db.listQa(listing.id) });
      res.json({ listing: listing.name, draft: d.reply_text, action: d.action, needs_pierce: d.action === 'ask_pierce' || d.action === 'escalate' || ctx.flags.usedSensitive, used_sensitive_docs: ctx.flags.usedSensitive, links: ctx.flags.links, question_for_pierce: d.question_for_pierce });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/selftest', requireKey, async (_req, res) => { const { selftest } = await import('./selftest.js'); const r = await selftest(); res.status(r.ok ? 200 : 500).json(r); });
  app.post('/admin/tick', requireKey, async (_req, res) => res.json(await tick()));

  return app;
}
