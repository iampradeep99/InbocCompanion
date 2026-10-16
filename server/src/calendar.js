import { z } from 'zod';
import { eventDetailsSchema, detailsSummary, encodeDetails, decodeDetails } from './event-details.js';

export const CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export function hasCalendarWriteAccess(tokens) {
  const scopes = new Set((tokens?.scope || '').split(' '));
  return [CALENDAR_WRITE_SCOPE, 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events.owned'].some(scope => scopes.has(scope));
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const common = {
  title: z.string().trim().min(1).max(200),
  location: z.string().max(1000).default(''),
  description: z.string().max(10000).default(''),
  details: eventDetailsSchema.optional(),
  reminderEmail: z.union([z.string().trim().email().max(254), z.literal('')]).default(''),
  etag: z.string().min(1).max(300).optional(),
  requestId: z.string().regex(/^[a-f0-9]{32}$/).optional()
};
const eventSchema = z.discriminatedUnion('allDay', [
  z.object({ ...common, allDay: z.literal(true), start: z.string().refine(validDate), end: z.string().refine(validDate) }).strict(),
  z.object({ ...common, allDay: z.literal(false), start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }),
    timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }) }).strict()
]).refine(value => new Date(value.end) > new Date(value.start), { message: 'End must be after start.' });

export function parseEventDetails(input) {
  const result = eventSchema.safeParse(input);
  if (!result.success) throw Object.assign(new Error('Enter a title, valid dates, an end after the start, and a valid reminder email if enabled. All-day end dates must be exclusive.'), { status: 400 });
  return result.data;
}
export function parseEventInput(input, creating = false) {
  const result = parseEventDetails(input);
  if (creating && !result.requestId) throw Object.assign(new Error('Missing event request ID. Reopen the event form.'), { status: 400 });
  if (!creating && !result.etag) throw Object.assign(new Error('Refresh the calendar before editing this event.'), { status: 409 });
  return result;
}

export function eventResource(input) {
  return { summary: input.title, location: input.location, description: (input.description || '') + (input.details ? detailsSummary(input.details) : ''),
    extendedProperties: { private: { ...(input.details ? encodeDetails(input.details) : {}), icReminderEmail: input.reminderEmail || null } },
    start: input.allDay ? { date: input.start } : { dateTime: input.start, timeZone: input.timeZone },
    end: input.allDay ? { date: input.end } : { dateTime: input.end, timeZone: input.timeZone } };
}

export function normalizeEvent(event, calendarTimeZone = 'UTC') {
  const details = decodeDetails(event.extendedProperties?.private);
  let description = event.description || '';
  const suffix = details && detailsSummary(details);
  if (suffix && description.endsWith(suffix)) description = description.slice(0, -suffix.length);
  return { id: event.id, title: event.summary || '(Untitled event)', description, ...(details ? { details } : {}),
    reminderEmail: event.extendedProperties?.private?.icReminderEmail || '',
    start: event.start, end: event.end, calendarTimeZone, location: event.location || '',
    url: event.htmlLink || '', meetingUrl: event.hangoutLink || '', etag: event.etag,
    recurring: !!event.recurringEventId,
    canEdit: (!event.eventType || event.eventType === 'default') && (event.organizer?.self === true || event.guestsCanModify === true) };
}

export function calendarError(error) {
  const status = Number(error.status || error.code || error.response?.status);
  if (error.reconnectRequired) return { status: 403, error: error.message, reconnectRequired: true };
  if (status === 400) return { status: 400, error: error.message || 'Invalid event details.' };
  if (status === 401 || /invalid_grant/i.test(error.message || '')) return { status: 401, error: 'Reconnect Google to restore Calendar access.', reconnectRequired: true };
  if (status === 403) return { status: 403, error: 'Google did not allow this change. Check Calendar edit permissions and whether you can modify this event.' };
  if ([404, 410].includes(status)) return { status: 404, error: 'This event was deleted or is no longer available. Refresh the calendar.' };
  if ([409, 412].includes(status)) return { status: 409, error: 'This event changed elsewhere. Refresh the calendar, then reopen it before saving or deleting.' };
  if (status === 429) return { status: 429, error: 'Google Calendar rate limit reached. Try again shortly.' };
  return { status: 502, error: 'Google Calendar could not confirm this change. Refresh to check the result before retrying.' };
}
