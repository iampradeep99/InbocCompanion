export function dueEvents(events, now = new Date()) {
  return events.filter(event => {
    if (event.start?.dateTime) {
      const start = new Date(event.start.dateTime).getTime();
      return start >= now.getTime() - 60000 && start <= now.getTime() + 15 * 60000;
    }
    // All-day events remind once at or after 9am in the browser's local time.
    const date = event.start?.date;
    if (!date) return false;
    const start = new Date(`${date}T09:00:00`);
    return now >= start && now.toDateString() === start.toDateString();
  });
}
export const reminderKey = (event, account) => `${account}:${event.id}:${event.start?.dateTime || event.start?.date}`;
