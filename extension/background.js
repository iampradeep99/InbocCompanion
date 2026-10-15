import { api, settings } from './api.js';
import { dueEvents, reminderKey } from './reminders.js';

// Register listeners synchronously; persist reminder IDs across worker restarts.
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'companion-refresh') refresh(); });
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); refresh(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refresh(); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'refresh') return;
  refresh().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
});
chrome.notifications.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.backend || changes.reminders)) refresh();
});

async function ensureAlarm() {
  if (!(await chrome.alarms.get('companion-refresh'))) await chrome.alarms.create('companion-refresh', { periodInMinutes: 1 });
}
let refreshing;
function refresh() {
  if (refreshing) return refreshing;
  refreshing = runRefresh().finally(() => { refreshing = null; });
  return refreshing;
}
async function runRefresh() {
  try {
    const config = await settings();
    if (!config.token) { await chrome.action.setBadgeText({ text: '' }); return; }
    const dashboard = await api('/api/dashboard');
    const calendarFresh = dashboard.calendarUpdatedAt && Date.now() - new Date(dashboard.calendarUpdatedAt) < 15 * 60000;
    const due = dashboard.connected && calendarFresh ? dueEvents(dashboard.events) : [];
    const important = dashboard.emails.filter(email => !email.dismissed).length;
    const count = important + due.length;
    await chrome.action.setBadgeBackgroundColor({ color: '#6656df' });
    await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : '' });
    await chrome.action.setTitle({ title: `${important} important emails · ${due.length} upcoming reminders` });
    const { notified = {} } = await chrome.storage.local.get('notified');
    const now = Date.now();
    for (const [key, timestamp] of Object.entries(notified)) if (now - timestamp > 8 * 86400000) delete notified[key];
    if (config.reminders) {
      for (const event of due) {
        const key = reminderKey(event, dashboard.account);
        if (notified[key]) continue;
        const when = event.start.dateTime ? new Date(event.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'All day';
        await chrome.notifications.create(`calendar-${event.id}`, { type: 'basic', iconUrl: 'icons/icon128.png',
          title: event.title, message: `${when}${event.location ? ` · ${event.location}` : ''}`, priority: 1 });
        notified[key] = now;
        await chrome.storage.local.set({ notified });
      }
    }
    await chrome.storage.local.set({ notified, backendError: '' });
  } catch (error) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ba542e' });
    await chrome.action.setTitle({ title: error.message });
    await chrome.storage.local.set({ backendError: error.message });
  }
}
ensureAlarm();
