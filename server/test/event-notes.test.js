import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventNotesGenerator } from '../src/ai.js';
import { createApp } from '../src/app.js';

const event = { title: 'Train home', allDay: true, start: '2026-10-31', end: '2026-11-01', location: 'Office to home', description: 'Carry laptop and charger.' };
test('AI notes use only supplied event context and validated final content', async () => {
  let request;
  const fake = { chat: { completions: { create: async (...args) => {
    request = args;
    return { choices: [{ message: { content: JSON.stringify({ notes: 'Check travel details. Carry laptop and charger.' }), reasoning_content: 'Hidden reasoning' } }] };
  } } } };
  const generate = createEventNotesGenerator({ model: 'openai/gpt-oss-20b' }, fake);
  const signal = new AbortController().signal;
  const result = await generate(event, { signal });
  assert.equal(result, 'Check travel details. Carry laptop and charger.');
  assert.equal(request[0].model, 'openai/gpt-oss-20b');
  const context = JSON.parse(request[0].messages[1].content);
  assert.equal(context.roughNotes, event.description); assert.equal(context.title, event.title);
  assert.equal(context.location, event.location); assert.equal(context.end, event.end);
  assert.ok(!result.includes('Hidden reasoning')); assert.equal(request[1].signal, signal);
  fake.chat.completions.create = async () => ({ choices: [{ message: { content: '{"notes":""}' } }] });
  await assert.rejects(generate(event));
  fake.chat.completions.create = async () => ({ choices: [{ message: { content: 'not JSON' } }] });
  await assert.rejects(generate(event));
});

test('generate notes API validates/authenticates requests and never saves an event', async t => {
  let generations = 0;
  let fail = false;
  const store = { data: { account: 'me@example.com', tokens: {}, events: [] } };
  const app = createApp({ apiToken: 'notes-test', store, google: {}, assistant: {
    saveEvent: async () => { throw new Error('Generation must never save events'); }
  }, generateEventNotes: async details => { generations++; if (fail) throw { status: 429 }; return `Prepare for ${details.title}. ${details.description}`; } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/events/generate-notes`;
  const headers = { Authorization: 'Bearer notes-test', 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...event, title: '' }) })).status, 400);
  assert.equal(generations, 0);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(event) });
  assert.equal(response.status, 200); assert.match((await response.json()).notes, /Carry laptop/);
  assert.deepEqual(store.data.events, []);
  fail = true;
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(event) })).status, 429);
  assert.equal(event.description, 'Carry laptop and charger.');
});
