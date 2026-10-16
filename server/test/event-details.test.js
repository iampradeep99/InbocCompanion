import test from 'node:test';
import assert from 'node:assert/strict';
import { eventDetailsSchema, encodeDetails, decodeDetails } from '../src/event-details.js';
import { parseEventDetails, eventResource, normalizeEvent } from '../src/calendar.js';

const details = eventDetailsSchema.parse({ type: 'travel', reference: 'PNR 123', bookedAt: '8 Sep 2026 00:44', amount: '4200', currency: 'INR',
  passengers: [{ name: 'प्रदीप', coach: 'B6', seat: '51', berth: 'Upper', amount: '2100' },
    { name: 'Lalita', coach: 'B6', seat: '52', berth: 'Lower' }], custom: [{ label: 'Booking fee', value: '40 INR' }] });
const event = { title: 'Train home', description: 'Carry ID.', allDay: true, start: '2026-11-01', end: '2026-11-02', details };

test('structured details retain individual passenger seats, booking time and total without inventing a fare', () => {
  const resource = eventResource(parseEventDetails(event));
  assert.match(resource.description, /प्रदीप.*Seat 51.*Berth Upper.*Fare 2100/);
  assert.match(resource.description, /Lalita.*Seat 52.*Berth Lower/);
  assert.match(resource.description, /Booked on: 8 Sep 2026 00:44/);
  assert.equal(resource.extendedProperties.private.icDetails19, null);
  const saved = normalizeEvent({ ...resource, id: 'ticket' });
  assert.deepEqual(saved.details, details);
  assert.equal(saved.description, 'Carry ID.');
  assert.equal(saved.details.passengers[1].amount, '');
  const updated = eventResource(parseEventDetails({ ...event, details: { ...saved.details, passengers: [] } }));
  assert.equal(normalizeEvent(updated).details.passengers.length, 0);
  assert.ok(!updated.description.includes('Passenger 1'));
});

test('detail storage chunks Unicode safely within Calendar limits, clears stale chunks, and rejects oversized data', () => {
  const large = eventDetailsSchema.parse({ custom: Array.from({ length: 8 }, (_, i) => ({ label: `Field ${i}`, value: '旅'.repeat(300) })) });
  const properties = encodeDetails(large);
  for (const value of Object.values(properties)) if (value) assert.ok(Buffer.byteLength(value) <= 900);
  assert.deepEqual(decodeDetails(properties), large);
  const smaller = { ...properties, ...encodeDetails(eventDetailsSchema.parse({})) };
  assert.deepEqual(decodeDetails(smaller), eventDetailsSchema.parse({}));
  assert.equal(smaller.icDetails12, null);
  assert.equal(decodeDetails({ icDetailsCount: '1000' }), undefined);
  assert.equal(decodeDetails({ icDetailsCount: '1', icDetails0: 'invalid json' }), undefined);
  assert.throws(() => eventDetailsSchema.parse({ passengers: Array.from({ length: 13 }, () => ({ name: 'test' })) }));
  assert.throws(() => eventDetailsSchema.parse({ custom: Array.from({ length: 20 }, () => ({ label: 'test', value: '旅'.repeat(500) })) }));
});

test('generic subjects retain custom details and externally edited notes are not discarded', () => {
  const parsed = parseEventDetails({ ...event, details: { type: 'meeting', custom: [{ label: 'Agenda', value: 'Project launch' }] } });
  const resource = eventResource(parsed);
  const saved = normalizeEvent(resource);
  assert.equal(saved.details.type, 'meeting');
  assert.equal(saved.details.custom[0].value, 'Project launch');
  assert.equal(saved.description, event.description);
  const external = normalizeEvent({ ...resource, description: 'Updated externally. ' + resource.description });
  assert.equal(external.description, 'Updated externally. Carry ID.');
  const changedSuffix = normalizeEvent({ ...resource, description: resource.description + '\nA new note.' });
  assert.match(changedSuffix.description, /A new note/);
});
