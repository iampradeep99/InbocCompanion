import { z } from 'zod';

const text = (max = 200) => z.string().trim().max(max).default('');
export const eventTypeSchema = z.enum(['general', 'travel', 'meeting', 'appointment', 'celebration', 'custom']);
export const eventDetailsSchema = z.object({
  type: eventTypeSchema.default('general'),
  reference: text(), operator: text(), serviceNumber: text(), travelClass: text(), from: text(), to: text(), boardingPoint: text(),
  bookedAt: text(), amount: text(), currency: text(20), paymentStatus: text(),
  passengers: z.array(z.object({ name: text(), age: text(20), gender: text(40), coach: text(60), seat: text(60),
    berth: text(80), status: text(120), amount: text(80) }).strict()).max(12).default([]),
  custom: z.array(z.object({ label: z.string().trim().min(1).max(80), value: z.string().trim().max(500) }).strict()).max(20).default([])
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 12000, 'Event details are too large.');

const labels = { reference: 'Booking reference / PNR', operator: 'Operator', serviceNumber: 'Train / flight / service',
  travelClass: 'Class', from: 'From', to: 'To', boardingPoint: 'Boarding point', bookedAt: 'Booked on',
  amount: 'Total paid', currency: 'Currency', paymentStatus: 'Payment status' };
export function detailsSummary(details) {
  const lines = [];
  if (details.type !== 'general') lines.push(`Event type: ${details.type}`);
  for (const [key, label] of Object.entries(labels)) if (details[key]) lines.push(`${label}: ${details[key]}`);
  for (const [index, p] of details.passengers.entries()) lines.push(`Passenger ${index + 1}: ${[
    p.name, p.age && `Age ${p.age}`, p.gender, p.coach && `Coach ${p.coach}`, p.seat && `Seat ${p.seat}`,
    p.berth && `Berth ${p.berth}`, p.status, p.amount && `Fare ${p.amount}`].filter(Boolean).join(' · ')}`);
  for (const item of details.custom) lines.push(`${item.label}: ${item.value}`);
  return lines.length ? `\n\n— Event details —\n${lines.join('\n')}` : '';
}
export function encodeDetails(details) {
  const privateProperties = {};
  let part = '', chunks = [];
  for (const char of JSON.stringify(details)) {
    if (Buffer.byteLength(part + char) > 900) { chunks.push(part); part = ''; }
    part += char;
  }
  if (part) chunks.push(part);
  privateProperties.icDetailsCount = String(chunks.length);
  // Explicitly remove previous chunks on a smaller edit without touching other properties.
  for (let i = 0; i < 20; i++) privateProperties[`icDetails${i}`] = chunks[i] ?? null;
  return privateProperties;
}
export function decodeDetails(properties) {
  const count = Number(properties?.icDetailsCount);
  if (!Number.isInteger(count) || count < 1 || count > 20) return undefined;
  try {
    const content = Array.from({ length: count }, (_, i) => properties[`icDetails${i}`]).join('');
    return eventDetailsSchema.parse(JSON.parse(content));
  } catch { return undefined; }
}
