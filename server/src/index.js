import 'dotenv/config';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { createGoogle } from './google.js';
import { createAnalyzer, createEventNotesGenerator } from './ai.js';
import { Assistant } from './assistant.js';
import { createApp } from './app.js';
import { DEFAULT_QUERY, LEGACY_QUERY } from './relevance.js';
import { serverConfig } from './config.js';

for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NVIDIA_API_KEY', 'API_TOKEN', 'ENCRYPTION_KEY']) {
  if (!process.env[name]?.trim()) throw new Error(`Missing ${name}. Run npm run setup and fill in .env.`);
}
if (process.env.API_TOKEN.length < 32) throw new Error('API_TOKEN must contain at least 32 characters.');
const { port, host, allowedHosts, redirectUri } = serverConfig();
const pollMinutes = Number(process.env.POLL_MINUTES || 5);
const maxEmails = Number(process.env.MAX_EMAILS_PER_SYNC || 20);
const calendarMonths = Number(process.env.CALENDAR_MONTHS || 12);
if (!Number.isFinite(pollMinutes) || pollMinutes < 1 || pollMinutes > 1440) throw new Error('POLL_MINUTES must be between 1 and 1440.');
if (!Number.isInteger(maxEmails) || maxEmails < 1 || maxEmails > 100) throw new Error('MAX_EMAILS_PER_SYNC must be between 1 and 100.');
if (!Number.isInteger(calendarMonths) || calendarMonths < 1 || calendarMonths > 24) throw new Error('CALENDAR_MONTHS must be between 1 and 24.');
const store = new Store(resolve(process.env.DATA_DIR || 'data', 'assistant.enc.json'), process.env.ENCRYPTION_KEY);
const google = createGoogle({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri, calendarId: process.env.CALENDAR_ID || 'primary', calendarMonths }, store);
// The old default excluded entire Gmail categories and could miss job alerts.
const query = !process.env.GMAIL_QUERY || process.env.GMAIL_QUERY === LEGACY_QUERY ? DEFAULT_QUERY : process.env.GMAIL_QUERY;
const assistant = new Assistant({ store, google, analyze: createAnalyzer({ apiKey: process.env.NVIDIA_API_KEY,
  model: process.env.NVIDIA_MODEL || 'openai/gpt-oss-20b' }), query, maxEmails, calendarMonths });
const app = createApp({ assistant, google, store, apiToken: process.env.API_TOKEN, allowedHosts,
  generateEventNotes: createEventNotesGenerator({ apiKey: process.env.NVIDIA_API_KEY, model: process.env.NVIDIA_MODEL || 'openai/gpt-oss-20b' }) });
const server = app.listen(port, host, () => console.log(`Inbox Companion listening at http://${host}:${port}`));
const sync = () => assistant.sync().catch(() => console.error('Sync failed; check local storage permissions and configuration.'));
sync();
const timer = setInterval(sync, pollMinutes * 60000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  clearInterval(timer);
  assistant.stop();
  server.close();
  if (assistant.running) await assistant.running.catch(() => {});
  await assistant.calendarTail;
  process.exit(0);
});
