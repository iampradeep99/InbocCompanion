import { google } from 'googleapis';
import { parseEmail, buildReply } from './mail.js';
import { CALENDAR_WRITE_SCOPE, hasCalendarWriteAccess, eventResource, normalizeEvent } from './calendar.js';
import { addMonths } from '../../extension/calendar-utils.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  CALENDAR_WRITE_SCOPE
];

export function createGoogle(config, store, clients = {}) {
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
  if (store.data.tokens) auth.setCredentials(store.data.tokens);
  auth.on('tokens', tokens => {
    store.data.tokens = { ...store.data.tokens, ...tokens };
    store.save();
  });
  const gmail = clients.gmail || google.gmail({ version: 'v1', auth });
  const calendar = clients.calendar || google.calendar({ version: 'v3', auth });
  function requireCalendarWrite() {
    if (!hasCalendarWriteAccess(store.data.tokens)) throw Object.assign(new Error('Reconnect Google in Settings and allow Calendar editing to add, edit, or delete events.'), { status: 403, reconnectRequired: true });
  }
  return {
    auth,
    canWriteEvents: () => hasCalendarWriteAccess(store.data.tokens),
    async connect(code) {
      const candidate = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
      const { tokens } = await candidate.getToken(code);
      const granted = new Set((tokens.scope || '').split(' '));
      if (SCOPES.some(scope => !granted.has(scope))) throw new Error('Please grant Gmail read, draft, and calendar access when connecting.');
      candidate.setCredentials(tokens);
      const { data } = await google.gmail({ version: 'v1', auth: candidate }).users.getProfile({ userId: 'me' });
      // This local app supports one account. Clear old findings on account change.
      if (store.data.account && store.data.account !== data.emailAddress) {
        store.data.emails = {}; store.data.events = []; store.data.lastSync = null;
        store.data.preferences = { jobProfile: '' };
      }
      store.data.tokens = tokens;
      store.data.account = data.emailAddress;
      auth.setCredentials(tokens);
      store.save();
    },
    async disconnect() {
      try { await auth.revokeCredentials(); } catch { /* Local removal must still succeed. */ }
      auth.setCredentials({});
      store.data = { tokens: null, account: null, emails: {}, events: [], lastSync: null, errors: [] };
      store.save();
    },
    async listMessages(query, pageToken) {
      const { data } = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50, pageToken });
      return data;
    },
    async getLatestEmail(id, threadId) {
      const { data: thread } = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'minimal' });
      const latest = (thread.messages || []).filter(m => !m.labelIds?.includes('DRAFT')).at(-1);
      if (!latest || latest.id !== id || latest.labelIds?.includes('SENT')) return null;
      const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'raw' });
      return parseEmail(data.raw, data);
    },
    async findDraft(email) {
      const { data } = await gmail.users.messages.list({ userId: 'me', q: `in:drafts rfc822msgid:inbox-companion-${email.id}@local.invalid` });
      if (!data.messages?.length) return null;
      let pageToken;
      do {
        const { data: drafts } = await gmail.users.drafts.list({ userId: 'me', maxResults: 100, pageToken });
        const match = drafts.drafts?.find(d => data.messages.some(m => m.id === d.message.id));
        if (match) return match.id;
        pageToken = drafts.nextPageToken;
      } while (pageToken);
      return null;
    },
    async saveDraft(email, text, draftId) {
      const raw = await buildReply(email, store.data.account, text);
      const requestBody = { message: { raw, threadId: email.threadId } };
      const { data } = draftId
        ? await gmail.users.drafts.update({ userId: 'me', id: draftId, requestBody })
        : await gmail.users.drafts.create({ userId: 'me', requestBody });
      return data.id;
    },
    async getDraft(id) {
      try {
        const { data } = await gmail.users.drafts.get({ userId: 'me', id, format: 'raw' });
        const email = await parseEmail(data.message.raw, data.message);
        return { text: email.body };
      } catch (error) {
        if (Number(error.code || error.response?.status) === 404) return null;
        throw error;
      }
    },
    async getEvents() {
      const now = Date.now();
      const timeMin = new Date(now).toISOString();
      const timeMax = addMonths(new Date(now), config.calendarMonths || 12).toISOString();
      const events = [];
      let pageToken;
      do {
        const { data } = await calendar.events.list({ calendarId: config.calendarId, timeMin, timeMax, singleEvents: true,
          orderBy: 'startTime', showDeleted: false, maxResults: 250, pageToken });
        store.data.calendarTimeZone = data.timeZone || 'UTC';
        for (const event of data.items || []) {
          if (event.status === 'cancelled' || event.attendees?.some(a => a.self && a.responseStatus === 'declined')) continue;
          events.push(normalizeEvent(event, data.timeZone));
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
      return events;
    },
    async saveEvent(input, id) {
      requireCalendarWrite();
      const resource = eventResource(input);
      const calendarId = config.calendarId || 'primary';
      if (id) {
        // Nulls clear the old nested date/dateTime representation when toggling all-day.
        const requestBody = { ...resource, start: { date: null, dateTime: null, timeZone: null, ...resource.start },
          end: { date: null, dateTime: null, timeZone: null, ...resource.end } };
        const { data } = await calendar.events.patch({ calendarId, eventId: id, requestBody, sendUpdates: 'none', conferenceDataVersion: 1 },
          { headers: { 'If-Match': input.etag }, retry: false });
        return normalizeEvent(data, store.data.calendarTimeZone || input.timeZone);
      }
      try {
        const { data } = await calendar.events.insert({ calendarId, sendUpdates: 'none', requestBody: { ...resource,
          id: input.requestId, extendedProperties: { private: { inboxCompanionRequest: input.requestId } } } }, { retry: false });
        return normalizeEvent(data, store.data.calendarTimeZone || input.timeZone);
      } catch (error) {
        if (Number(error.code || error.status || error.response?.status) !== 409) throw error;
        // Stable client-generated IDs prevent duplicate events after a lost response.
        const { data } = await calendar.events.get({ calendarId, eventId: input.requestId });
        if (data.extendedProperties?.private?.inboxCompanionRequest !== input.requestId) throw error;
        return normalizeEvent(data, store.data.calendarTimeZone || input.timeZone);
      }
    },
    async deleteEvent(id, etag) {
      requireCalendarWrite();
      try {
        await calendar.events.delete({ calendarId: config.calendarId || 'primary', eventId: id, sendUpdates: 'none' },
          { headers: { 'If-Match': etag }, retry: false });
      } catch (error) {
        if (![404, 410].includes(Number(error.code || error.status || error.response?.status))) throw error;
      }
    }
  };
}
