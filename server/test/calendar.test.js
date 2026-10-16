import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, eventHasEnded, upcomingEvents } from '../../extension/calendar-utils.js';
import { parseEventInput, eventResource, CALENDAR_WRITE_SCOPE } from '../src/calendar.js';
import { createGoogle } from '../src/google.js';
import { Assistant } from '../src/assistant.js';
import { createApp } from '../src/app.js';

const input = { title: 'Planning', allDay: false, start: '2026-10-31T19:00:00+05:30', end: '2026-10-31T20:00:00+05:30',
  timeZone: 'Asia/Kolkata', requestId: '0123456789abcdef0123456789abcdef' };
test('12 calendar months preserve the clock and clamp leap-day anniversaries', () => {
  assert.equal(addMonths(new Date('2026-10-15T11:55:00Z'), 12).toISOString(), '2027-10-15T11:55:00.000Z');
  assert.equal(addMonths(new Date('2028-02-29T11:55:00Z'), 12).toISOString(), '2029-02-28T11:55:00.000Z');
});
test('past events expire at end time; all-day dates expire in calendar timezone', () => {
  const now = new Date('2026-10-15T19:00:00Z'); // October 16, 00:30 in India.
  assert.equal(eventHasEnded({ end: { dateTime: now.toISOString() } }, now), true);
  assert.equal(eventHasEnded({ end: { date: '2026-10-16' }, calendarTimeZone: 'Asia/Kolkata' }, now), true);
  assert.equal(eventHasEnded({ end: { date: '2026-10-16' }, calendarTimeZone: 'America/New_York' }, now), false);
  const events = [
    { id: 'ongoing', start: { dateTime: '2026-10-15T18:30:00Z' }, end: { dateTime: '2026-10-15T19:30:00Z' } },
    { id: 'elevenMonths', start: { dateTime: '2027-09-15T10:00:00Z' }, end: { dateTime: '2027-09-15T11:00:00Z' } },
    { id: 'past', start: { dateTime: '2026-10-14T10:00:00Z' }, end: { dateTime: '2026-10-14T11:00:00Z' } },
    { id: 'tooFar', start: { dateTime: '2027-10-16T10:00:00Z' }, end: { dateTime: '2027-10-16T11:00:00Z' } }
  ];
  assert.deepEqual(upcomingEvents(events, now).map(e => e.id), ['ongoing', 'elevenMonths']);
});
test('event validation rejects invalid dates, missing versions, unexpected fields and reversed ranges', () => {
  assert.equal(eventResource(parseEventInput(input, true)).start.timeZone, 'Asia/Kolkata');
  for (const change of [{ title: '' }, { end: input.start }, { timeZone: 'Not/AZone' }, { requestId: undefined }, { attendees: ['unrequested@example.com'] }]) {
    assert.throws(() => parseEventInput({ ...input, ...change }, true));
  }
  assert.throws(() => parseEventInput(input));
  assert.throws(() => parseEventInput({ ...input, allDay: true, start: '2026-02-30', end: '2026-03-02', timeZone: undefined }, true));
  const allDay = parseEventInput({ title: 'Day off', allDay: true, start: '2026-10-31', end: '2026-11-01', requestId: input.requestId }, true);
  assert.deepEqual(eventResource(allDay).end, { date: '2026-11-01' });
});

test('Google adapter pages a full year, preserves recurrence instances, guards writes and reconciles creates', async () => {
  const calls = [];
  const resource = { id: input.requestId, summary: input.title, start: { dateTime: input.start }, end: { dateTime: input.end },
    organizer: { self: true }, etag: 'v1', recurringEventId: 'series', extendedProperties: { private: { inboxCompanionRequest: input.requestId } } };
  let duplicate = false;
  let deleteError;
  const events = {
    list: async params => {
      calls.push(['list', params]);
      return { data: { items: [resource], timeZone: 'Asia/Kolkata', nextPageToken: params.pageToken ? undefined : 'page2' } };
    },
    insert: async (...args) => { calls.push(['insert', ...args]); if (duplicate) throw { code: 409 }; duplicate = true; return { data: resource }; },
    get: async () => ({ data: resource }),
    patch: async (...args) => { calls.push(['patch', ...args]); return { data: { ...resource, summary: args[0].requestBody.summary, etag: 'v2' } }; },
    delete: async (...args) => { calls.push(['delete', ...args]); if (deleteError) throw { code: deleteError }; }
  };
  const store = { data: { tokens: { scope: 'https://www.googleapis.com/auth/calendar.events.readonly' } }, save() {} };
  const provider = createGoogle({ calendarId: 'primary', calendarMonths: 12 }, store, { gmail: {}, calendar: { events } });
  await assert.rejects(provider.saveEvent(parseEventInput(input, true)), error => error.reconnectRequired);
  assert.equal(calls.length, 0);
  const result = await provider.getEvents();
  assert.equal(result.length, 2); assert.equal(result[0].recurring, true); assert.equal(result[0].canEdit, true);
  assert.equal(calls[0][1].singleEvents, true);
  assert.equal(calls[0][1].timeMax, addMonths(new Date(calls[0][1].timeMin), 12).toISOString());
  assert.equal(calls[1][1].pageToken, 'page2');
  store.data.tokens.scope = CALENDAR_WRITE_SCOPE;
  const created = await provider.saveEvent(parseEventInput(input, true));
  const retry = await provider.saveEvent(parseEventInput(input, true));
  assert.equal(created.id, retry.id);
  await provider.saveEvent(parseEventInput({ ...input, details: { type: 'travel', passengers: [{ name: 'Alex', seat: '24' }] } }, true));
  const detailedInsert = calls.filter(call => call[0] === 'insert').at(-1)[1].requestBody;
  assert.equal(detailedInsert.extendedProperties.private.inboxCompanionRequest, input.requestId);
  assert.ok(detailedInsert.extendedProperties.private.icDetailsCount);
  assert.ok(Object.values(detailedInsert.extendedProperties.private).every(value => value !== null));
  const updated = await provider.saveEvent(parseEventInput({ title: 'All-day planning', allDay: true, start: '2026-10-31', end: '2026-11-01', etag: 'v1' }), 'instance');
  assert.equal(updated.title, 'All-day planning');
  const patch = calls.find(call => call[0] === 'patch');
  assert.equal(patch[1].eventId, 'instance'); assert.equal(patch[1].requestBody.start.dateTime, null);
  assert.equal(patch[2].headers['If-Match'], 'v1'); assert.equal(patch[1].sendUpdates, 'none');
  deleteError = 410; await provider.deleteEvent('instance', 'v2');
  const deletion = calls.find(call => call[0] === 'delete');
  assert.equal(deletion[2].headers['If-Match'], 'v2');
  deleteError = 412; await assert.rejects(provider.deleteEvent('instance', 'v2'));
});

test('calendar refresh and mutations serialize so an old fetch cannot resurrect a deleted event', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const event = { id: 'one', start: { dateTime: new Date(Date.now() + 3600000).toISOString() }, end: { dateTime: new Date(Date.now() + 7200000).toISOString() } };
  const store = { data: { events: [event] }, save() {} };
  const google = { getEvents: async () => { await gate; return [event]; }, deleteEvent: async () => {} };
  const assistant = new Assistant({ store, google });
  const refresh = assistant.refreshCalendar();
  const deletion = assistant.deleteEvent('one', 'v1');
  release(); await Promise.all([refresh, deletion]);
  assert.deepEqual(store.data.events, []); assert.equal(assistant.calendarBusy, 0);
});
test('reconnect interrupts a slow AI scan without recording a false failure or creating a draft', async () => {
  let started;
  const analyzing = new Promise(resolve => { started = resolve; });
  const store = { data: { account: 'me@example.com', tokens: {}, events: [], emails: {}, errors: [] }, save() {} };
  let drafts = 0;
  const google = { getEvents: async () => [], listMessages: async () => ({ messages: [{ id: 'one', threadId: 'thread' }] }),
    getLatestEmail: async () => ({ id: 'one' }), saveDraft: async () => { drafts++; } };
  const assistant = new Assistant({ store, google, maxEmails: 1, analyze: (_email, _account, _profile, { signal }) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }) });
  assistant.sync(); await analyzing;
  assistant.accountChanging = true; await assistant.settleAccountWork();
  assert.equal(assistant.running, null); assert.equal(drafts, 0); assert.deepEqual(store.data.emails, {});
});

test('calendar CRUD API enforces auth/validation, writes only explicit requests and maps conflicts', async t => {
  const storedEvents = [];
  const store = { data: { account: 'me@example.com', tokens: {}, emails: {}, events: [], errors: [] }, save() {} };
  let mutations = 0;
  const google = { canWriteEvents: () => true, getEvents: async () => storedEvents,
    saveEvent: async (data, id) => {
      mutations++;
      if (data.etag === 'old') throw { code: 412 };
      const event = { id: id || data.requestId, title: data.title, start: { dateTime: data.start }, end: { dateTime: data.end }, etag: 'v2' };
      storedEvents.push(event); return event;
    }, deleteEvent: async () => { mutations++; } };
  const assistant = new Assistant({ store, google });
  const server = createApp({ store, google, assistant, apiToken: 'token' }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };
  const body = { ...input, start: new Date(Date.now() + 86400000).toISOString(), end: new Date(Date.now() + 90000000).toISOString() };
  assert.equal((await fetch(`${base}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  assert.equal((await fetch(`${base}/api/events`, { method: 'POST', headers, body: JSON.stringify({ ...body, title: '' }) })).status, 400);
  assert.equal(mutations, 0);
  assert.equal((await fetch(`${base}/api/events`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 201);
  assert.equal(assistant.dashboard().events.length, 1);
  assert.equal((await fetch(`${base}/api/events/one`, { method: 'PUT', headers, body: JSON.stringify({ ...body, etag: 'old' }) })).status, 409);
  assert.equal((await fetch(`${base}/api/events/one`, { method: 'DELETE', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(`${base}/api/events/${body.requestId}`, { method: 'DELETE', headers, body: JSON.stringify({ etag: 'v2' }) })).status, 200);
  assert.equal(assistant.dashboard().events.length, 0);
});
