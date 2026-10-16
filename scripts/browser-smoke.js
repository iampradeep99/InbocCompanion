import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Assistant } from '../server/src/assistant.js';
import { createApp } from '../server/src/app.js';
import { eventResource, normalizeEvent } from '../server/src/calendar.js';
import { randomBytes } from 'node:crypto';

// An isolated browser profile and fake providers: no real mail or accounts.
const token = 'browser-smoke-test-token-01234567890123456789';
const now = Date.now();
const store = { data: { account: 'you@example.com', tokens: {}, emails: {}, events: [], errors: [] }, save() {} };
const sample = { id: 'sample1', threadId: 'thread1', from: 'Alex Morgan <alex@example.com>', recipient: 'alex@example.com',
  subject: 'A quick review before tomorrow?', body: 'Hi! Could you review the project outline before our planning session tomorrow? Thanks, Alex.',
  date: new Date(now).toISOString(), messageId: '<sample@example.com>' };
const analysis = { category: 'direct', jobMatch: 'not_applicable', important: true, priority: 'high', summary: 'Alex needs your feedback on the project outline before tomorrow’s planning session.',
  reason: 'A direct request with an upcoming deadline.', needsReply: true, draft: 'Hi Alex,\n\nThanks for sharing the outline. I’ll review it and follow up with my feedback.\n\nBest,\n[Your name]' };
let draftText = analysis.draft;
let eventRevision = 1;
let calendarWrite = false;
let sampleEvents = [{ id: 'planning', title: 'Project planning', start: { dateTime: new Date(now + 10 * 60000).toISOString() },
  end: { dateTime: new Date(now + 70 * 60000).toISOString() }, location: 'Studio meeting room', url: 'https://calendar.google.com/',
  meetingUrl: 'https://meet.google.com/abc-defg-hij', etag: 'v1', canEdit: true }];
const google = {
  auth: { generateAuthUrl: () => 'https://accounts.google.com/' },
  canWriteEvents: () => calendarWrite,
  getEvents: async () => structuredClone(sampleEvents),
  saveEvent: async (input, id) => {
    const event = normalizeEvent({ ...eventResource(input), id: id || input.requestId, organizer: { self: true }, etag: `v${++eventRevision}`, htmlLink: 'https://calendar.google.com/' });
    sampleEvents = [...sampleEvents.filter(e => e.id !== event.id), event]; return event;
  },
  deleteEvent: async id => { sampleEvents = sampleEvents.filter(e => e.id !== id); },
  listMessages: async () => ({ messages: [{ id: sample.id, threadId: sample.threadId }] }),
  getLatestEmail: async () => ({ ...sample }),
  saveDraft: async (_email, text) => { draftText = text; return 'draft1'; },
  getDraft: async () => ({ text: draftText }), findDraft: async () => null,
  disconnect: async () => { store.data.account = null; store.data.tokens = null; store.data.emails = {}; store.data.events = []; }
};
const assistant = new Assistant({ store, google, analyze: async () => analysis, query: 'in:inbox', maxEmails: 20 });
await assistant.sync();
let ticketImportMode = 'normal';
const app = createApp({ store, google, assistant, apiToken: token,
  importTicket: async () => {
    const mode = ticketImportMode;
    await new Promise(resolve => setTimeout(resolve, mode === 'slow' ? 1000 : 450));
    if (mode === 'error') throw new Error('Provider unavailable');
    return { title: 'Train to Jaipur', location: 'Delhi station', description: 'Carry ID. Check the platform before boarding.',
      details: { type: 'travel', reference: 'ABC123', operator: 'Indian Railways', serviceNumber: '12345', travelClass: '3A',
        from: 'Delhi', to: 'Jaipur', boardingPoint: 'Delhi station', bookedAt: '8 Sep 2026, 00:44', amount: '4200', currency: 'INR', paymentStatus: 'Paid',
        passengers: [{ name: 'Alex Morgan', age: '36', gender: 'M', coach: 'B2', seat: '24', berth: 'Upper', status: 'Confirmed', amount: '2100' },
          { name: 'Taylor Morgan', age: '27', gender: 'F', coach: 'B2', seat: '25', berth: 'Lower', status: 'Confirmed', amount: '' }],
        custom: [{ label: 'Transaction ID', value: 'TX123' }] },
      start: new Date(now + 86400000).toISOString(), end: mode === 'missing' ? null : new Date(now + 100800000).toISOString(),
      warnings: mode === 'missing' ? ['Arrival time missing; enter it manually.'] : [] };
  },
  generateEventNotes: async details => `Prepare for ${details.title}. Review the agenda and keep your resume ready. ${details.description}` });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const profile = mkdtempSync(join(tmpdir(), 'inbox-browser-test-'));
const errors = [];
let context;
try {
  const extension = resolve('extension');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 600, height: 600 } });
  context.on('weberror', error => errors.push(error.error().message));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.locator('#backend').fill(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#token').fill(token);
  await page.locator('#reminders').uncheck();
  await page.getByRole('button', { name: 'Save & test connection' }).click();
  await page.getByText('Settings saved. Backend connected.').waitFor();
  await page.locator('#job-profile').fill('Target role: Node.js backend developer. Experience: 3 years. Location: remote.');
  await page.getByRole('button', { name: 'Save job profile & recheck inbox' }).click();
  await page.getByText('Profile saved.', { exact: false }).waitFor();
  assert.ok(store.data.preferences.jobProfile.includes('Node.js'));
  await assistant.sync();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByRole('heading', { name: sample.subject }).waitFor();
  await page.getByRole('button', { name: 'Job matches', exact: true }).click();
  await page.getByText('All caught up.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Direct messages', exact: true }).click();
  await page.getByRole('heading', { name: sample.subject }).waitFor();
  assert.equal(await page.locator('#profile-prompt').isVisible(), false);
  await page.getByRole('button', { name: 'All matches', exact: true }).click();
  await page.getByText('Why this matters · Read email', { exact: true }).click();
  assert.ok((await page.locator('.email-body').textContent()).includes('Could you review'));
  await page.getByText('Why this matters · Read email', { exact: true }).click();
  mkdirSync('docs', { recursive: true });
  await page.locator('main').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: 'docs/extension-preview.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.body.getBoundingClientRect().width), 600);
  const [expanded] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: 'Open larger dashboard' }).click()
  ]);
  await expanded.setViewportSize({ width: 1440, height: 1000 });
  await expanded.getByRole('heading', { name: sample.subject }).waitFor();
  assert.ok(await expanded.locator('html').evaluate(node => node.classList.contains('expanded')));
  assert.ok(await expanded.locator('body').evaluate(node => node.getBoundingClientRect().width > 1000));
  await expanded.screenshot({ path: 'docs/dashboard-preview.png', fullPage: true });
  await expanded.setViewportSize({ width: 390, height: 800 });
  assert.ok(await expanded.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await expanded.close();
  await page.locator('[data-tab="drafts"]').click();
  await page.locator('.draft-editor').fill('Hi Alex, here is my edited reply.');
  await page.getByRole('button', { name: 'Save changes to Gmail' }).click();
  await page.getByText('Draft updated in Gmail.').waitFor();
  assert.equal(draftText, 'Hi Alex, here is my edited reply.');
  await page.locator('[data-tab="calendar"]').click();
  await page.getByRole('heading', { name: 'Project planning' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Join meeting' }).getAttribute('href'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(await page.locator('#new-event').isDisabled(), true);
  await page.locator('#calendar-access').waitFor({ state: 'visible' });
  calendarWrite = true;
  await page.locator('#refresh-calendar').click();
  await page.locator('#calendar-access').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'New event' }).click();
  await page.locator('#event-ticket').setInputFiles({ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nMock ticket for browser import') });
  await page.locator('#ticket-progress').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#event-title').isDisabled(), true);
  assert.equal(await page.locator('#save-event').isDisabled(), true);
  await page.locator('#ticket-preview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#event-title').inputValue(), 'Train to Jaipur');
  assert.equal(await page.locator('#event-location').inputValue(), 'Delhi station');
  assert.ok(await page.locator('#event-start').inputValue());
  assert.ok(await page.locator('#event-end').inputValue());
  assert.match(await page.locator('#event-description').inputValue(), /Carry ID/);
  assert.equal(await page.locator('#event-kind').inputValue(), 'travel');
  assert.equal(await page.locator('#details-bookedAt').inputValue(), '8 Sep 2026, 00:44');
  assert.equal(await page.locator('#details-amount').inputValue(), '4200');
  assert.equal(await page.locator('.passenger-editor').count(), 2);
  assert.equal(await page.locator('.passenger-editor').nth(0).locator('[data-field=seat]').inputValue(), '24');
  assert.equal(await page.locator('.passenger-editor').nth(1).locator('[data-field=amount]').inputValue(), '');
  assert.equal(await page.locator('#save-event').isDisabled(), false);
  assert.equal(await page.locator('#ticket-progress').isVisible(), false);
  assert.match(await page.locator('#ticket-status').textContent(), /5 fields filled automatically/);
  assert.equal(sampleEvents.length, 1);
  await page.setViewportSize({ width: 1000, height: 1050 });
  await page.screenshot({ path: 'docs/ticket-autofill-preview.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 600, height: 600 });
  ticketImportMode = 'missing';
  await page.locator('#event-ticket').setInputFiles({ name: 'missing-arrival.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nMock ticket') });
  await page.locator('#ticket-preview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#event-end').inputValue(), '');
  assert.match(await page.locator('#ticket-status').textContent(), /missing end time/);
  ticketImportMode = 'slow';
  await page.locator('#event-ticket').setInputFiles({ name: 'cancel-ticket.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nMock ticket') });
  await page.locator('#ticket-progress').waitFor({ state: 'visible' });
  await page.locator('#cancel-ticket').click();
  await page.locator('#event-title').fill('My edited journey');
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#event-title').inputValue(), 'My edited journey');
  ticketImportMode = 'error';
  await page.locator('#event-ticket').setInputFiles({ name: 'retry-ticket.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nMock ticket') });
  await page.locator('#retry-ticket').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#event-title').inputValue(), 'My edited journey');
  ticketImportMode = 'normal';
  await page.locator('#retry-ticket').click();
  await page.locator('#ticket-preview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#event-title').inputValue(), 'Train to Jaipur');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#event-title').evaluate(field => getComputedStyle(field).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.passenger-editor').nth(1).locator('[data-field=seat]').fill('19');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  const travelCard = page.locator('.event-card').filter({ hasText: 'Train to Jaipur' });
  await travelCard.waitFor();
  assert.match(await travelCard.textContent(), /Alex Morgan/);
  assert.match(await travelCard.textContent(), /Seat number: 19/);
  assert.match(await travelCard.textContent(), /4200 INR/);
  await page.setViewportSize({ width: 1000, height: 1050 });
  const calendarPreview = await context.newPage();
  await calendarPreview.setViewportSize({ width: 1440, height: 1100 });
  await calendarPreview.goto(`chrome-extension://${id}/popup.html?view=expanded`);
  await calendarPreview.locator('[data-tab=calendar]').click();
  await calendarPreview.getByRole('heading', { name: 'Train to Jaipur', exact: true }).waitFor();
  await calendarPreview.screenshot({ path: 'docs/green-calendar-preview.png', fullPage: true, animations: 'disabled' });
  await calendarPreview.close();
  await travelCard.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.locator('.passenger-editor').nth(1).locator('[data-field=seat]').inputValue(), '19');
  assert.equal(await page.locator('#details-reference').inputValue(), 'ABC123');
  await page.locator('#passenger-list').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/passenger-form-preview.png', fullPage: true, animations: 'disabled' });
  await page.locator('#cancel-event').click();
  page.once('dialog', dialog => dialog.accept());
  await travelCard.getByRole('button', { name: 'Delete', exact: true }).click();
  await travelCard.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 600, height: 600 });
  await page.getByRole('button', { name: 'New event' }).click();
  await page.locator('#event-title').fill('Interview preparation');
  await page.locator('#event-kind').selectOption('meeting');
  await page.locator('#custom-detail-list [data-field=value]').nth(0).fill('Alex and Taylor');
  await page.locator('#custom-detail-list [data-field=value]').nth(1).fill('Discuss the launch plan');
  const dates = await page.evaluate(() => {
    const local = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return [local(new Date(Date.now() + 86400000)), local(new Date(Date.now() + 90000000))];
  });
  await page.locator('#event-start').fill(dates[0]);
  await page.locator('#event-end').fill(dates[1]);
  await page.locator('#event-description').fill('Review Node.js interview topics.');
  await page.getByRole('button', { name: 'Generate with AI', exact: false }).click();
  await page.locator('#event-ai-preview').waitFor({ state: 'visible' });
  assert.match(await page.locator('#event-generated-notes').inputValue(), /Interview preparation/);
  assert.equal(await page.locator('#event-description').inputValue(), 'Review Node.js interview topics.');
  assert.equal(sampleEvents.length, 1);
  await page.locator('#event-location').fill('Home office');
  assert.equal(await page.locator('#event-ai-preview').isVisible(), false);
  await page.getByRole('button', { name: 'Generate with AI', exact: false }).click();
  await page.locator('#event-ai-preview').waitFor({ state: 'visible' });
  await page.screenshot({ path: 'docs/event-notes-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Use these notes' }).click();
  assert.match(await page.locator('#event-description').inputValue(), /Prepare for Interview preparation/);
  assert.equal(sampleEvents.length, 1);
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await page.getByRole('heading', { name: 'Interview preparation', exact: true }).waitFor();
  assert.equal(sampleEvents.length, 2);
  assert.match(sampleEvents.find(event => event.title === 'Interview preparation').description, /Review Node.js interview topics/);
  assert.equal(sampleEvents.find(event => event.title === 'Interview preparation').details.type, 'meeting');
  assert.match(await page.locator('.event-card').filter({ hasText: 'Interview preparation' }).textContent(), /Discuss the launch plan/);
  await page.locator('.event-card').filter({ hasText: 'Interview preparation' }).getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.locator('#event-kind').inputValue(), 'meeting');
  assert.equal(await page.locator('#custom-detail-list [data-field=value]').nth(1).inputValue(), 'Discuss the launch plan');
  await page.locator('#event-title').fill('All-day interview preparation');
  await page.locator('#event-all-day').check();
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await page.getByRole('heading', { name: 'All-day interview preparation', exact: true }).waitFor();
  assert.ok(sampleEvents.some(event => event.title === 'All-day interview preparation' && event.start.date && event.end.date));
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.event-card').filter({ hasText: 'All-day interview preparation' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('heading', { name: 'All-day interview preparation', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(sampleEvents.length, 1);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [title, days] of [['Past appointment', -2], ['Next year planning', 330]]) {
    const result = await fetch(`${base}/api/events`, { method: 'POST', headers, body: JSON.stringify({ title, allDay: false, timeZone: 'UTC',
      start: new Date(now + days * 86400000).toISOString(), end: new Date(now + days * 86400000 + 3600000).toISOString(), requestId: randomBytes(16).toString('hex') }) });
    assert.equal(result.status, 201);
  }
  await page.locator('#refresh-calendar').click();
  await page.getByRole('heading', { name: 'Next year planning', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Past appointment', exact: true }).count(), 0);
  assert.equal(await page.locator('#section-title').textContent(), 'THE NEXT 12 MONTHS');
  await page.locator('main').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: 'docs/calendar-preview.png', fullPage: true });
  await page.locator('[data-tab="inbox"]').click();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await page.getByText('All caught up.', { exact: false }).waitFor();
  // Exercise the real worker, notifications API and persistent deduplication.
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ reminders: true });
    await chrome.runtime.getPlatformInfo();
  });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'refresh' }));
  const reminderState = await worker.evaluate(() => chrome.storage.local.get(['notified', 'backendError']));
  assert.equal(reminderState.backendError, '');
  assert.equal(Object.keys(reminderState.notified).length, 1);
  const firstNotified = JSON.stringify(reminderState.notified);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'refresh' }));
  assert.equal(JSON.stringify((await worker.evaluate(() => chrome.storage.local.get('notified'))).notified), firstNotified);
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '1');
  await page.goto(`chrome-extension://${id}/options.html`);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Disconnect & clear local data' }).click();
  await page.getByText('Google disconnected. Local data cleared.').waitFor();
  assert.equal(store.data.account, null);
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: extension, pairing, job filters, expanded dashboard, inbox/drafts, calendar permission prompt, create/edit/all-day/delete, 12-month lookahead, past-event expiry, reminders, badge, disconnect.');
} finally {
  if (context) await context.close();
  server.closeAllConnections(); server.close();
  rmSync(profile, { recursive: true, force: true });
}
