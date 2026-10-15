import express from 'express';
import helmet from 'helmet';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SCOPES } from './google.js';
import { friendlyError } from './assistant.js';
import { z } from 'zod';
import { parseEventInput, parseEventDetails, calendarError } from './calendar.js';

export function createApp({ assistant, google, store, apiToken, generateEventNotes }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Reject DNS rebinding and web-page access. All API calls also require a secret.
    if (!['127.0.0.1', 'localhost'].includes(req.hostname)) return res.status(403).json({ error: 'Local access only.' });
    const origin = req.get('Origin');
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return res.status(403).json({ error: 'Extension access only.' });
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  const states = new Map();
  app.get('/health', (_req, res) => res.json({ ok: true, name: 'Inbox Companion' }));
  app.get('/auth/google/callback', async (req, res) => {
    const expires = states.get(req.query.state);
    states.delete(req.query.state);
    if (!expires || expires < Date.now()) return res.status(400).type('text').send('Connection expired. Return to the extension and connect again.');
    if (req.query.error || typeof req.query.code !== 'string') return res.status(400).type('text').send('Google access was not granted. Return to the extension to try again.');
    if (assistant.accountChanging) return res.status(409).type('text').send('An account change is running. Wait until it finishes, then reconnect.');
    assistant.accountChanging = true;
    try {
      await assistant.settleAccountWork();
      await google.connect(req.query.code);
      res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>Google connected</title></head><body><h1>Google connected</h1><p>Return to Inbox Companion in Chrome. You can close this tab.</p></body></html>');
    } catch (error) { res.status(400).type('text').send(`Unable to connect. ${friendlyError(error)} Ensure all requested permissions are selected.`); }
    finally { assistant.abortController = new AbortController(); assistant.accountChanging = false; }
    assistant.sync().catch(() => {});
  });
  app.use('/api', (req, res, next) => {
    const provided = Buffer.from((req.get('Authorization') || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(apiToken);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return res.status(401).json({ error: 'Pairing token is invalid. Check extension settings.' });
    next();
  });
  app.get('/api/dashboard', (_req, res) => res.json(assistant.dashboard()));
  app.use('/api/events', (req, res, next) => {
    if (!store.data.account || !store.data.tokens) return res.status(409).json({ error: 'Connect Google first.' });
    if (assistant.accountChanging) return res.status(409).json({ error: 'Wait for the account change to finish.' });
    next();
  });
  function eventFailure(error, res) {
    const result = calendarError(error);
    res.status(result.status).json(result);
  }
  app.post('/api/events/generate-notes', async (req, res) => {
    let details;
    try { details = parseEventDetails(req.body); }
    catch (error) { return eventFailure(error, res); }
    if (!generateEventNotes) return res.status(503).json({ error: 'AI notes generation is not configured on this backend.' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const notes = await generateEventNotes(details, { signal: controller.signal });
      if (!res.destroyed) res.json({ notes });
    } catch (error) {
      if (res.destroyed) return;
      const status = Number(error.status || error.code || error.response?.status);
      if (status === 429) return res.status(429).json({ error: 'NVIDIA rate limit reached. Try generating notes again shortly.' });
      if (status === 401 || status === 403) return res.status(502).json({ error: 'Check the NVIDIA API key and model access in the backend configuration.' });
      res.status(502).json({ error: 'AI could not generate usable notes. Your existing notes are unchanged. Please try again.' });
    }
  });
  app.post('/api/events/refresh', async (_req, res) => {
    try { await assistant.refreshCalendar(); res.json({ ok: true }); }
    catch (error) { eventFailure(error, res); }
  });
  app.post('/api/events', async (req, res) => {
    try {
      const event = await assistant.saveEvent(parseEventInput(req.body, true));
      res.status(201).json({ event });
    } catch (error) { eventFailure(error, res); }
  });
  app.put('/api/events/:id', async (req, res) => {
    try {
      const event = await assistant.saveEvent(parseEventInput(req.body), req.params.id);
      res.json({ event });
    } catch (error) { eventFailure(error, res); }
  });
  app.delete('/api/events/:id', async (req, res) => {
    const body = z.object({ etag: z.string().min(1).max(300) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Refresh the calendar before deleting this event.' });
    try { await assistant.deleteEvent(req.params.id, body.data.etag); res.json({ ok: true }); }
    catch (error) { eventFailure(error, res); }
  });
  app.get('/api/preferences', (_req, res) => res.json({ jobProfile: store.data.preferences?.jobProfile || '' }));
  app.put('/api/preferences', (req, res) => {
    if (typeof req.body.jobProfile !== 'string' || req.body.jobProfile.length > 12000) return res.status(400).json({ error: 'Job profile must be text up to 12,000 characters.' });
    if (assistant.accountChanging) return res.status(409).json({ error: 'Wait for the account change to finish.' });
    store.data.preferences = { jobProfile: req.body.jobProfile.trim() };
    store.save();
    assistant.sync().catch(() => {});
    res.json({ ok: true });
  });
  app.post('/api/auth/url', (_req, res) => {
    for (const [key, expires] of states) if (expires < Date.now()) states.delete(key);
    const state = randomBytes(32).toString('hex');
    states.set(state, Date.now() + 10 * 60000);
    res.json({ url: google.auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state }) });
  });
  app.post('/api/sync', (_req, res) => {
    if (!store.data.account) return res.status(409).json({ error: 'Connect Google first.' });
    assistant.sync().catch(() => {});
    res.status(202).json({ syncing: true });
  });
  app.post('/api/disconnect', async (_req, res) => {
    if (assistant.accountChanging) return res.status(409).json({ error: 'Wait for the account change to finish before disconnecting.' });
    assistant.accountChanging = true;
    try { await assistant.settleAccountWork(); await google.disconnect(); }
    finally { assistant.abortController = new AbortController(); assistant.accountChanging = false; }
    res.json({ ok: true });
  });
  app.post('/api/emails/:id/dismiss', (req, res) => {
    const email = store.data.emails[req.params.id];
    if (!email?.analysis) return res.status(404).json({ error: 'Email not found.' });
    email.dismissed = true; store.save(); res.json({ ok: true });
  });
  app.post('/api/retry-failed', (_req, res) => {
    if (assistant.running) return res.status(409).json({ error: 'Wait for the current sync to finish.' });
    for (const email of Object.values(store.data.emails)) if (email.analysisError || (!email.analysis && email.error)) email.attempts = 0;
    store.save(); assistant.sync().catch(() => {}); res.status(202).json({ ok: true });
  });
  app.put('/api/drafts/:id', async (req, res) => {
    const email = Object.values(store.data.emails).find(e => e.draftId === req.params.id);
    if (!email) return res.status(404).json({ error: 'Draft not found.' });
    if (typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 20000) return res.status(400).json({ error: 'Reply must be between 1 and 20,000 characters.' });
    try {
      await google.saveDraft(email, req.body.text, email.draftId);
      email.draftText = req.body.text; store.save(); res.json({ ok: true });
    } catch (error) {
      const missing = Number(error.code || error.status || error.response?.status) === 404;
      res.status(missing ? 404 : 502).json({ error: missing ? 'This draft was sent or deleted in Gmail. It will not be recreated.' : friendlyError(error) });
    }
  });
  app.use((err, _req, res, _next) => res.status(400).json({ error: 'Invalid request.' }));
  return app;
}
