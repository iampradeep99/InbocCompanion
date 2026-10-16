import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText, createTicketImporter, MAX_PDF_BYTES } from '../src/ticket.js';
import { createApp } from '../src/app.js';

function ticketPdf() {
  const content = 'BT /F1 12 Tf 20 250 Td (Train 12345 Delhi to Jaipur PNR ABC123 Departure 31 Oct 2026 09:00 Arrival 13:00) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
const ticket = { title: 'Train to Jaipur', location: 'Delhi station', description: 'Train 12345. PNR ABC123.',
  start: '2026-10-31T09:00:00+05:30', end: '2026-10-31T13:00:00+05:30', warnings: [] };

test('real PDF extraction reads a ticket and rejects invalid PDFs', async () => {
  assert.match(await extractPdfText(ticketPdf()), /PNR ABC123/);
  await assert.rejects(extractPdfText(Buffer.from('%PDF-invalid')), /Unable to read/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractPdfText(ticketPdf(), { signal: controller.signal }), /cancelled/);
});

test('ticket AI receives extracted text only and validates times and missing details', async () => {
  let request;
  let output = ticket;
  const client = { chat: { completions: { create: async (...args) => {
    request = args; return { choices: [{ message: { content: JSON.stringify(output), reasoning_content: 'Do not expose' } }] };
  } } } };
  const importer = createTicketImporter({ model: 'test' }, client, async () => 'Train 12345 Delhi Jaipur PNR ABC123');
  assert.deepEqual(await importer(ticketPdf(), 'Asia/Kolkata'), ticket);
  assert.deepEqual(JSON.parse(request[0].messages[1].content), { timeZone: 'Asia/Kolkata', ticketText: 'Train 12345 Delhi Jaipur PNR ABC123' });
  output = { ...ticket, start: null, end: null, warnings: ['Dates missing'] };
  assert.equal((await importer(ticketPdf(), 'Asia/Kolkata')).start, null);
  output = { ...ticket, end: '2026-10-30T13:00:00+05:30' };
  await assert.rejects(importer(ticketPdf(), 'Asia/Kolkata'));
  const scanned = createTicketImporter({}, client, async () => '');
  await assert.rejects(scanned(ticketPdf(), 'UTC'), /Scanned/);
});

test('ticket import requires authentication, bounds uploads and never writes Calendar', async t => {
  let imports = 0;
  const store = { data: { account: 'me@example.com', tokens: {}, events: [] } };
  const app = createApp({ apiToken: 'ticket-test', store, google: {}, assistant: {}, importTicket: async (pdf, zone) => {
    imports++; assert.match(pdf.toString(), /^%PDF-/); assert.equal(zone, 'Asia/Kolkata'); return ticket;
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/events/import-ticket`;
  const headers = { Authorization: 'Bearer ticket-test', 'Content-Type': 'application/json' };
  const body = { pdf: ticketPdf().toString('base64'), timeZone: 'Asia/Kolkata' };
  const post = (input, customHeaders = headers) => fetch(url, { method: 'POST', headers: customHeaders, body: JSON.stringify(input) });
  assert.equal((await post(body, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post({ ...body, timeZone: 'Invalid/Zone' })).status, 400);
  assert.equal((await post({ ...body, pdf: Buffer.from('not a pdf').toString('base64') })).status, 400);
  const large = Buffer.alloc(90000, ' '); large.write('%PDF-');
  assert.equal((await post({ ...body, pdf: large.toString('base64') })).status, 200);
  assert.equal((await post({ ...body, pdf: Buffer.alloc(MAX_PDF_BYTES + 1).toString('base64') })).status, 400);
  const result = await post(body);
  assert.equal(result.status, 200); assert.deepEqual((await result.json()).ticket, ticket);
  assert.equal(imports, 2); assert.deepEqual(store.data.events, []);
  store.data.account = null;
  assert.equal((await post(body)).status, 409);
});
