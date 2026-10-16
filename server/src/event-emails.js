import { createHash } from 'node:crypto';

const HOUR = 3600000;
const DAY = 24 * HOUR;
function localParts(time, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time)).map(p => [p.type, p.value]));
}
function localTime(date, hour, timeZone) {
  const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  let result = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(result, timeZone);
    result += target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  }
  return result;
}
function timing(event) {
  const zone = event.start.timeZone || event.calendarTimeZone || 'Asia/Kolkata';
  const start = event.start.dateTime ? Date.parse(event.start.dateTime) : localTime(event.start.date, 9, zone);
  const p = localParts(start, zone);
  const date = `${p.year}-${p.month}-${p.day}`;
  return { start, dayStart: localTime(date, 0, zone), morning: localTime(date, 8, zone) };
}

// Choose only the latest due slot after downtime, never a burst of missed emails.
function dueSlot(job, now) {
  const { start, dayStart, morning } = timing(job.event);
  if (!Number.isFinite(start)) return null;
  if (!job.confirmedAt) return 'confirmation';
  if (now >= start) return null;
  const slots = [];
  const created = Date.parse(job.createdAt);
  const daySlot = created + Math.floor((now - created) / (2 * DAY)) * 2 * DAY;
  if (daySlot > created && daySlot < dayStart) slots.push(daySlot);
  if (now >= morning) {
    const slot = morning + Math.floor((now - morning) / (2 * HOUR)) * 2 * HOUR;
    if (slot < start - 3 * HOUR) slots.push(slot);
  }
  for (const hours of [3, 2, 1]) if (start - hours * HOUR <= now) slots.push(start - hours * HOUR);
  const latest = Math.max(...slots.filter(time => time > created));
  if (!Number.isFinite(latest) || latest <= (job.lastReminderAt || 0)) return null;
  return String(latest);
}

export class EventEmails {
  constructor({ store, google }) {
    this.store = store;
    this.google = google;
  }
  upsert(event) {
    const jobs = this.store.data.eventEmailJobs ||= {};
    if (!event.reminderEmail) { delete jobs[event.id]; return; }
    const old = jobs[event.id];
    if (old && old.account === this.store.data.account && old.recipient === event.reminderEmail) {
      old.event = event;
    } else {
      jobs[event.id] = { event, recipient: event.reminderEmail, account: this.store.data.account,
        createdAt: new Date().toISOString(), confirmedAt: null, lastReminderAt: 0 };
    }
  }
  remove(id) { delete (this.store.data.eventEmailJobs || {})[id]; }
  tick() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    if (!this.store.data.account || !this.store.data.tokens) return;
    for (const [id, job] of Object.entries(this.store.data.eventEmailJobs || {})) {
      if (this.stopped || job.account !== this.store.data.account) return;
      if ((job.retryAfter || 0) > Date.now()) continue;
      try {
        const event = await this.google.getEvent(id);
        if (!event || !event.reminderEmail || event.reminderEmail !== job.recipient) {
          if (event?.reminderEmail) this.upsert(event); else this.remove(id);
          this.store.save(); continue;
        }
        job.event = event;
        if (job.confirmedAt && Date.now() >= timing(event).start) { this.remove(id); this.store.save(); continue; }
        const slot = dueSlot(job, Date.now());
        if (!slot && !job.pending) continue;
        if (job.pending) {
          // A lost send response must be reconciled, rather than sending twice.
          const sent = await this.google.findSentEventEmail(job.pending.messageId);
          if (!sent) { job.error = 'Email delivery is unconfirmed. Check Sent mail; reconciliation will retry.'; this.store.save(); continue; }
          this.delivered(job, job.pending.slot);
          this.store.save(); continue;
        }
        const messageId = `ic-event-${createHash('sha256').update(`${job.account}:${id}:${job.recipient}:${slot}`).digest('hex')}@local.invalid`;
        job.pending = { slot, messageId };
        this.store.save();
        await this.google.sendEventEmail(event, job.recipient, messageId, slot === 'confirmation' ? 'confirmation' : 'reminder');
        this.delivered(job, slot);
        this.store.save();
      } catch (error) {
        const status = Number(error.code || error.status || error.response?.status);
        if ([404, 410].includes(status)) this.remove(id);
        else {
          if ([400, 401, 403, 429].includes(status)) delete job.pending; // Provider explicitly refused the send.
          job.retryAfter = Date.now() + 5 * 60000;
          job.error = [401, 403].includes(status) ? 'Reconnect Google to allow reminder emails.' : 'Email reminder could not be confirmed. Retrying in the background.';
        }
        this.store.save();
      }
    }
  }
  delivered(job, slot) {
    if (slot === 'confirmation') job.confirmedAt = new Date().toISOString();
    else job.lastReminderAt = Number(slot);
    delete job.pending; delete job.error; delete job.retryAfter;
  }
  async stop() { this.stopped = true; if (this.running) await this.running; }
}
