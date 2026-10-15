export function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function calendarDate(now, timeZone) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now); }
  catch { parts = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now); }
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function eventHasEnded(event, now = new Date()) {
  if (event.end?.dateTime) return new Date(event.end.dateTime).getTime() <= now.getTime();
  // Google all-day end dates are exclusive, in the calendar's timezone.
  if (event.end?.date) return event.end.date <= calendarDate(now, event.calendarTimeZone || event.start?.timeZone || 'UTC');
  return false;
}

export function upcomingEvents(events, now = new Date(), months = 12) {
  const limit = addMonths(now, months);
  return events.filter(event => {
    if (eventHasEnded(event, now)) return false;
    if (event.start?.dateTime) return new Date(event.start.dateTime) < limit;
    if (event.start?.date) return event.start.date < calendarDate(limit, event.calendarTimeZone || 'UTC');
    return false;
  }).sort((a, b) => new Date(a.start.dateTime || `${a.start.date}T00:00:00Z`) - new Date(b.start.dateTime || `${b.start.date}T00:00:00Z`));
}
