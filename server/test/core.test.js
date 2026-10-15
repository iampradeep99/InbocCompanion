import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { Store } from '../src/store.js';
import { buildReply, parseEmail, canReply } from '../src/mail.js';
import { parseAnalysis } from '../src/ai.js';
import { Assistant } from '../src/assistant.js';
import { createApp } from '../src/app.js';
import { dueEvents, reminderKey } from '../../extension/reminders.js';
import { applyRelevance, relevanceKey } from '../src/relevance.js';

const email = { id: 'm1', threadId: 't1', from: 'Alice <alice@example.com>', recipient: 'alice@example.com',
  subject: 'Review needed ✓', body: 'Can you review this?', messageId: '<original@example.com>', references: ['<older@example.com>'], date: '2026-10-15T09:00:00.000Z' };
const analysis = { category: 'direct', jobMatch: 'not_applicable', important: true, priority: 'high', summary: 'Review requested', reason: 'A direct request', needsReply: true, draft: 'Thanks, I will take a look.' };
function fixture(overrides = {}) {
  const store = { data: { tokens: {}, account: 'me@example.com', emails: {}, events: [], errors: [] }, save() {} };
  let saves = 0;
  const google = { getEvents: async () => [], listMessages: async () => ({ messages: [{ id: 'm1', threadId: 't1' }] }),
    getLatestEmail: async () => ({ ...email }), saveDraft: async () => { saves++; return 'd1'; }, getDraft: async () => ({ text: analysis.draft }),
    findDraft: async () => null, ...overrides };
  const assistant = new Assistant({ store, google, analyze: async () => ({ ...analysis }), query: 'in:inbox', maxEmails: 20 });
  return { store, google, assistant, saves: () => saves };
}
test('encrypted store survives restart and rejects a wrong key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-test-'));
  try {
    const file = join(dir, 'data.enc'); const key = randomBytes(32).toString('hex');
    const store = new Store(file, key); store.data.account = 'private@example.com'; store.save();
    assert.ok(!readFileSync(file, 'utf8').includes('private@example.com'));
    assert.equal(new Store(file, key).data.account, 'private@example.com');
    assert.throws(() => new Store(file, randomBytes(32).toString('hex')));
  } finally { rmSync(dir, { recursive: true }); }
});
test('MIME reply preserves Unicode, reply recipient, thread references, and body', async () => {
  const raw = await buildReply(email, 'me@example.com', 'Thank you — I’ll review.');
  const parsed = await simpleParser(Buffer.from(raw, 'base64url'));
  assert.equal(parsed.subject, 'Re: Review needed ✓');
  assert.equal(parsed.to.value[0].address, 'alice@example.com');
  assert.equal(parsed.inReplyTo, '<original@example.com>');
  assert.ok(parsed.references.includes('<older@example.com>'));
  assert.match(parsed.text, /Thank you — I’ll review/);
  assert.equal(parsed.messageId, '<inbox-companion-m1@local.invalid>');
});
test('HTML-only email parsing and Reply-To work without forwarding attachments', async () => {
  const raw = Buffer.from('From: A <a@example.com>\r\nReply-To: Help <help@example.com>\r\nSubject: Test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>world</b></p><script>bad()</script>').toString('base64url');
  const parsed = await parseEmail(raw, { id: 'a', threadId: 'b' });
  assert.equal(parsed.recipient, 'help@example.com'); assert.match(parsed.body, /Hello world/); assert.ok(!parsed.body.includes('bad()'));
});
test('automated, list, no-reply and self mail do not receive reply drafts', () => {
  for (const change of [{ recipient: 'no-reply@example.com' }, { listMessage: true }, { autoSubmitted: 'auto-generated' }, { recipient: 'ME@example.com' }]) {
    assert.equal(canReply({ ...email, ...change }, 'me@example.com'), false);
  }
});
test('AI output is validated and empty requested drafts rejected', () => {
  assert.deepEqual(parseAnalysis('```json\n' + JSON.stringify(analysis) + '\n```'), analysis);
  assert.throws(() => parseAnalysis(JSON.stringify({ ...analysis, important: 'true' })));
  assert.throws(() => parseAnalysis(JSON.stringify({ ...analysis, draft: '' })));
  assert.throws(() => parseAnalysis(JSON.stringify({ ...analysis, category: 'newsletter' })));
  assert.throws(() => parseAnalysis(JSON.stringify({ ...analysis, jobMatch: 'perfect' })));
});
test('only strong job matches with a profile are visible; other alerts stay hidden', () => {
  const job = { ...analysis, category: 'job', jobMatch: 'strong' };
  assert.equal(applyRelevance(job, email, 'me@example.com', 'Node.js developer').important, true);
  assert.equal(applyRelevance(job, email, 'me@example.com', '').important, false);
  for (const jobMatch of ['weak', 'unknown', 'not_applicable']) {
    const result = applyRelevance({ ...job, jobMatch }, email, 'me@example.com', 'Node.js developer');
    assert.equal(result.important, false); assert.equal(result.needsReply, false); assert.equal(result.draft, '');
  }
  const otp = applyRelevance({ ...analysis, category: 'other', important: true }, email, 'me@example.com', 'Node.js developer');
  assert.equal(otp.important, false); assert.equal(otp.draft, '');
});
test('direct human correspondence is shown without urgency, while automated mail is rejected', () => {
  assert.equal(applyRelevance({ ...analysis, important: false, needsReply: false, draft: '' }, email, 'me@example.com', '').important, true);
  for (const change of [{ recipient: 'noreply@example.com' }, { autoSubmitted: 'auto-generated' }, { listMessage: true }]) {
    assert.equal(applyRelevance(analysis, { ...email, ...change }, 'me@example.com', '').important, false);
  }
  // A job-site digest may be a useful match but should not receive a reply draft.
  const job = applyRelevance({ ...analysis, category: 'job', jobMatch: 'strong' }, { ...email, listMessage: true }, 'me@example.com', 'Node.js');
  assert.equal(job.important, true); assert.equal(job.needsReply, false);
});
test('legacy results are hidden until rechecked, preserving existing Gmail drafts and user edits', async () => {
  const f = fixture();
  f.store.data.emails.m1 = { ...email, analysis: { ...analysis }, draftId: 'existing', draftStatus: 'saved', draftText: 'User edit' };
  f.google.getDraft = async () => ({ text: 'User edit' });
  assert.equal(f.assistant.dashboard().emails.length, 0);
  await f.assistant.sync();
  assert.equal(f.assistant.dashboard().emails.length, 1);
  assert.equal(f.store.data.emails.m1.draftText, 'User edit'); assert.equal(f.saves(), 0);
});
test('profile changes invalidate cached matches and failed rechecks preserve existing draft IDs', async () => {
  const f = fixture(); await f.assistant.sync();
  f.store.data.preferences = { jobProfile: 'Python developer' };
  assert.equal(f.assistant.dashboard().emails.length, 0);
  f.assistant.analyze = async () => { throw new SyntaxError('invalid AI response'); };
  await f.assistant.sync();
  assert.equal(f.store.data.emails.m1.draftId, 'd1');
  assert.equal(f.assistant.dashboard().failedEmails.length, 1);
  f.assistant.analyze = async () => ({ ...analysis });
  await f.assistant.sync();
  assert.equal(f.saves(), 1); assert.equal(f.assistant.dashboard().failedEmails.length, 0);
  assert.equal(f.store.data.emails.m1.contextKey, relevanceKey('Python developer'));
});
test('an in-flight result from an old profile cannot become visible', async () => {
  const f = fixture();
  f.assistant.analyze = async () => { f.store.data.preferences = { jobProfile: 'New role' }; return { ...analysis }; };
  await f.assistant.sync(); assert.equal(f.assistant.dashboard().emails.length, 0); assert.equal(f.saves(), 0);
});
test('overlapping syncs share one run; later runs do not duplicate drafts', async () => {
  const f = fixture();
  await Promise.all([f.assistant.sync(), f.assistant.sync()]);
  await f.assistant.sync();
  assert.equal(f.saves(), 1); assert.equal(f.store.data.emails.m1.draftStatus, 'saved');
});
test('uncertain draft creation is reconciled and never blindly retried', async () => {
  let calls = 0;
  const f = fixture({ saveDraft: async () => { calls++; throw new Error('Lost response'); } });
  await f.assistant.sync(); await f.assistant.sync();
  assert.equal(calls, 1); assert.equal(f.store.data.emails.m1.draftStatus, 'uncertain');
  f.google.findDraft = async () => 'recovered';
  await f.assistant.sync();
  assert.equal(f.store.data.emails.m1.draftId, 'recovered'); assert.equal(calls, 1);
});
test('sent/deleted drafts are removed from the review list and not recreated', async () => {
  const f = fixture({ getDraft: async () => null });
  await f.assistant.sync(); await f.assistant.sync();
  assert.equal(f.store.data.emails.m1.draftStatus, 'removed'); assert.equal(f.saves(), 1);
});
test('AI failures are retried up to three times, while calendar remains available', async () => {
  const f = fixture({ getEvents: async () => [{ id: 'event', start: { dateTime: new Date(Date.now() + 3600000).toISOString() }, end: { dateTime: new Date(Date.now() + 7200000).toISOString() } }] });
  let calls = 0; f.assistant.analyze = async () => { calls++; throw new SyntaxError('not json'); };
  for (let i = 0; i < 4; i++) await f.assistant.sync();
  assert.equal(calls, 3); assert.equal(f.assistant.dashboard().failedEmails.length, 1); assert.equal(f.store.data.events.length, 1);
});
test('pagination finds new emails beyond the first processed page', async () => {
  const f = fixture({ listMessages: async (_q, page) => page ? { messages: [{ id: 'm1', threadId: 't1' }] } : { messages: [{ id: 'old' }], nextPageToken: 'next' } });
  f.store.data.emails.old = { skipped: true };
  await f.assistant.sync(); assert.equal(f.saves(), 1);
});
test('calendar reminders handle 15-minute windows, all-day dates and reschedules', () => {
  const now = new Date('2026-10-15T10:00:00');
  const timed = { id: 'one', start: { dateTime: new Date(now.getTime() + 14 * 60000).toISOString() } };
  const later = { id: 'two', start: { dateTime: new Date(now.getTime() + 16 * 60000).toISOString() } };
  const allDay = { id: 'three', start: { date: '2026-10-15' } };
  assert.deepEqual(dueEvents([timed, later, allDay], now).map(e => e.id), ['one', 'three']);
  assert.notEqual(reminderKey(timed, 'a'), reminderKey(timed, 'b'));
  assert.notEqual(reminderKey(timed, 'a'), reminderKey({ ...timed, start: later.start }, 'a'));
});
test('API requires pairing token, rejects website origins, protects OAuth state and saves edits', async t => {
  const f = fixture(); await f.assistant.sync();
  f.google.auth = { generateAuthUrl: ({ state }) => `https://accounts.google.com/auth?state=${state}` };
  const app = createApp({ ...f, apiToken: 'secret-pairing-token' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer secret-pairing-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
  assert.equal((await fetch(`${base}/api/dashboard`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/dashboard`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/auth/google/callback?state=bad&code=bad`)).status, 400);
  const auth = await (await fetch(`${base}/api/auth/url`, { method: 'POST', headers })).json();
  assert.equal(new URL(auth.url).searchParams.get('state').length, 64);
  assert.equal((await fetch(`${base}/api/drafts/d1`, { method: 'PUT', headers, body: JSON.stringify({ text: 'Edited reply' }) })).status, 200);
  assert.equal(f.store.data.emails.m1.draftText, 'Edited reply');
  assert.equal((await fetch(`${base}/api/drafts/d1`, { method: 'PUT', headers, body: JSON.stringify({ text: '' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/emails/m1/dismiss`, { method: 'POST', headers })).status, 200);
  assert.equal(f.store.data.emails.m1.dismissed, true);
  assert.equal((await fetch(`${base}/api/send`, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${base}/api/preferences`)).status, 401);
  assert.equal((await fetch(`${base}/api/preferences`, { method: 'PUT', headers, body: JSON.stringify({ jobProfile: 42 }) })).status, 400);
  assert.equal((await fetch(`${base}/api/preferences`, { method: 'PUT', headers, body: JSON.stringify({ jobProfile: 'x'.repeat(12001) }) })).status, 400);
  assert.equal((await fetch(`${base}/api/preferences`, { method: 'PUT', headers, body: JSON.stringify({ jobProfile: ' Node.js backend developer ' }) })).status, 200);
  const preferences = await (await fetch(`${base}/api/preferences`, { headers })).json();
  assert.equal(preferences.jobProfile, 'Node.js backend developer');
});
