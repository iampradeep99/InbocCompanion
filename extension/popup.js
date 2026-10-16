import { api, safeUrl } from './api.js';
import { upcomingEvents } from './calendar-utils.js';

const $ = selector => document.querySelector(selector);
if (new URLSearchParams(location.search).get('view') === 'expanded') {
  document.documentElement.classList.add('expanded');
  $('#expand').hidden = true;
}
let dashboard;
let tab = 'inbox';
let inboxFilter = 'all';
let loading = false;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(text, url, className = 'text-link') {
  const node = element('a', className, text);
  const safe = safeUrl(url);
  if (safe) { node.href = safe; node.target = '_blank'; node.rel = 'noreferrer'; }
  return node;
}
function notice(message, isError = true) {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
  $('#notice').classList.toggle('success', !isError);
}
async function action(button, fn) {
  button.disabled = true;
  try { await fn(); } catch (error) { notice(error.message); }
  finally { button.disabled = false; }
}
async function load() {
  if (loading) return;
  loading = true;
  try {
    dashboard = await api('/api/dashboard');
    $('#account').textContent = dashboard.account || 'Your day, a little lighter.';
    $('#connect-panel').hidden = dashboard.connected;
    $('#sync').disabled = !dashboard.connected || dashboard.syncing;
    $('#sync-status').textContent = dashboard.syncing ? 'Reviewing your inbox…' : dashboard.lastSync ? `Last checked ${new Date(dashboard.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Ready when you are';
    const issues = [...dashboard.errors];
    if (dashboard.connected && dashboard.calendarUpdatedAt && Date.now() - new Date(dashboard.calendarUpdatedAt) > 15 * 60000) issues.push('Calendar data is older than 15 minutes.');
    notice(issues.join(' '));
    $('#inbox-count').textContent = dashboard.emails.filter(e => !e.dismissed).length;
    $('#draft-count').textContent = dashboard.emails.filter(e => e.draftId || ['pending', 'uncertain'].includes(e.draftStatus)).length;
    $('#event-count').textContent = currentEvents().length;
    $('#failed').hidden = !dashboard.failedEmails.length;
    $('#failed-text').textContent = `${dashboard.failedEmails.length} emails could not be analyzed. ${dashboard.failedEmails[0]?.error || ''}`;
    render();
  } catch (error) {
    notice(error.message);
    $('#sync-status').textContent = 'Backend not connected';
    $('#sync').disabled = true;
    $('#content').replaceChildren(element('div', 'empty', 'Start the backend and add your pairing token in Settings to get started.'));
  } finally { loading = false; }
}
function currentEvents() {
  return upcomingEvents(dashboard?.events || [], new Date(), dashboard?.calendarWindowMonths || 12);
}
function render() {
  const content = $('#content');
  // Keep in-progress draft edits intact during background refresh.
  if (content.querySelector('textarea:focus') || content.querySelector('textarea[data-dirty="true"]')) return;
  content.replaceChildren();
  $('#section-title').textContent = { inbox: 'JOBS & DIRECT MESSAGES', drafts: 'READY FOR YOUR REVIEW', calendar: `THE NEXT ${dashboard.calendarWindowMonths || 12} MONTHS` }[tab];
  $('#section-note').textContent = tab === 'calendar' ? '15 min reminders' : tab === 'drafts' ? 'Saved in Gmail' : 'AI filtered';
  $('#mail-filters').hidden = tab !== 'inbox';
  $('#profile-prompt').hidden = tab !== 'inbox' || dashboard.jobProfileConfigured;
  $('#calendar-tools').hidden = tab !== 'calendar';
  $('#calendar-access').hidden = tab !== 'calendar' || !dashboard.connected || dashboard.calendarCanWrite;
  $('#new-event').disabled = !dashboard.connected || !dashboard.calendarCanWrite;
  $('#refresh-calendar').disabled = !dashboard.connected;
  const items = tab === 'calendar' ? currentEvents() : dashboard.emails.filter(e => tab === 'drafts' ? !!e.draftId || ['pending', 'uncertain'].includes(e.draftStatus) : !e.dismissed && (inboxFilter === 'all' || e.analysis.category === inboxFilter));
  if (!items.length) content.append(element('div', 'empty', tab === 'calendar' ? `No upcoming events in the next ${dashboard.calendarWindowMonths || 12} months. Add something to look forward to.` : tab === 'drafts' ? 'Your reply drafts will appear here.' : 'All caught up. Relevant jobs and direct messages will appear here.'));
  for (const item of items) content.append(tab === 'calendar' ? eventCard(item) : emailCard(item));
}
function emailCard(email) {
  const card = element('article', 'card email-card');
  const meta = element('div', 'card-meta');
  const from = email.from.replace(/\s*<[^>]+>/, '');
  meta.append(element('span', 'sender', from), element('span', `pill ${email.analysis.category}`, email.analysis.category === 'job' ? 'Job match' : 'Direct message'));
  card.append(meta, element('h3', '', email.subject), element('p', 'summary', email.analysis.summary));
  const details = element('details');
  details.append(element('summary', '', 'Why this matters · Read email'));
  details.append(element('p', 'reason', email.analysis.reason), element('pre', 'email-body', email.body));
  card.append(details);
  if (email.error) card.append(element('p', 'warning', email.error));
  if (tab === 'drafts' && (email.draftId || ['pending', 'uncertain'].includes(email.draftStatus))) {
    const label = element('label', 'draft-label', 'YOUR REPLY DRAFT');
    const textarea = element('textarea', 'draft-editor');
    textarea.value = email.draftText;
    textarea.readOnly = !email.draftId;
    textarea.setAttribute('aria-label', `Reply draft for ${email.subject}`);
    textarea.addEventListener('input', () => { textarea.dataset.dirty = 'true'; });
    const save = element('button', 'primary compact', 'Save changes to Gmail');
    save.addEventListener('click', () => action(save, async () => {
      await api(`/api/drafts/${encodeURIComponent(email.draftId)}`, { method: 'PUT', body: JSON.stringify({ text: textarea.value }) });
      textarea.dataset.dirty = 'false'; textarea.blur();
      email.draftText = textarea.value;
      notice('Draft updated in Gmail.', false);
    }));
    card.append(label, textarea);
    if (email.draftId) card.append(save);
  }
  const actions = element('div', 'card-actions');
  const mailbox = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(dashboard.account)}#all/${encodeURIComponent(email.threadId)}`;
  actions.append(link(email.draftId ? 'Review in Gmail ↗' : 'Open email ↗', mailbox));
  if (email.draftStatus === 'saved') actions.append(element('span', 'saved', '✓ Draft saved'));
  if (tab === 'inbox') {
    const dismiss = element('button', 'quiet', 'Dismiss');
    dismiss.addEventListener('click', () => action(dismiss, async () => {
      await api(`/api/emails/${encodeURIComponent(email.id)}/dismiss`, { method: 'POST' });
      await load(); chrome.runtime.sendMessage({ type: 'refresh' });
    }));
    actions.append(dismiss);
  }
  card.append(actions);
  return card;
}
function eventCard(event) {
  const card = element('article', 'card event-card');
  const date = new Date(event.start.dateTime || `${event.start.date}T00:00:00`);
  const dateBox = element('div', 'date-box');
  dateBox.append(element('span', '', date.toLocaleDateString([], { month: 'short' }).toUpperCase()), element('strong', '', date.getDate()));
  const info = element('div', 'event-info');
  const when = event.start.dateTime ? date.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : `${date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · All day`;
  info.append(element('span', 'event-time', when), element('h3', '', event.title));
  if (event.location) info.append(element('p', '', event.location));
  const actions = element('div', 'card-actions');
  actions.append(link('View event ↗', event.url));
  if (event.meetingUrl) actions.append(link('Join meeting ↗', event.meetingUrl));
  if (dashboard.calendarCanWrite && event.etag) {
    if (event.canEdit) {
      const edit = element('button', 'quiet event-edit', 'Edit');
      edit.addEventListener('click', () => openEventForm(event));
      actions.append(edit);
    }
    const remove = element('button', 'quiet danger event-delete', 'Delete');
    remove.addEventListener('click', () => action(remove, async () => {
      const occurrence = event.recurring ? ' This removes only this occurrence.' : '';
      if (!window.confirm(`Delete “${event.title}” from Google Calendar?${occurrence}`)) return;
      await api(`/api/events/${encodeURIComponent(event.id)}`, { method: 'DELETE', body: JSON.stringify({ etag: event.etag }) });
      await load(); notice('Event deleted from Google Calendar.', false);
      chrome.runtime.sendMessage({ type: 'refresh' });
    }));
    actions.append(remove);
  }
  if (event.description) {
    const details = element('details');
    details.append(element('summary', '', 'Event notes'), element('pre', 'email-body', event.description));
    info.append(details);
  }
  info.append(actions); card.append(dateBox, info);
  return card;
}
let editingEvent = null;
let eventRequestId;
let notesRequest = null;
let notesVersion = 0;
let ticketRequest = null;
let ticketVersion = 0;
let ticketSuggestion = null;
const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function localInput(date) {
  const value = new Date(date);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function shiftDay(value, count) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
function setDateTypes(allDay) {
  $('#event-start').type = $('#event-end').type = allDay ? 'date' : 'datetime-local';
  $('#event-end-label').textContent = allDay ? 'Last day (inclusive)' : 'End';
  $('#event-timezone').textContent = allDay ? 'All-day dates follow your Google Calendar’s timezone.' : `Times are in ${localTimeZone} (this computer).`;
}
function openEventForm(event = null) {
  resetTicket();
  resetAiNotes();
  editingEvent = event;
  eventRequestId = crypto.randomUUID().replaceAll('-', '');
  $('#event-form').reset();
  $('#event-form-error').hidden = true;
  $('#event-dialog-title').textContent = event ? 'Edit event' : 'New event';
  $('#event-title').value = event?.title || '';
  $('#event-location').value = event?.location || '';
  $('#event-description').value = event?.description || '';
  const allDay = !!event?.start?.date;
  $('#event-all-day').checked = allDay;
  setDateTypes(allDay);
  const start = new Date(Math.ceil((Date.now() + 60000) / 1800000) * 1800000);
  $('#event-start').value = allDay ? event.start.date : localInput(event?.start?.dateTime || start);
  $('#event-end').value = allDay ? shiftDay(event.end.date, -1) : localInput(event?.end?.dateTime || new Date(start.getTime() + 3600000));
  $('#event-recurring-note').hidden = !event?.recurring;
  $('#event-dialog').showModal();
}
$('#new-event').addEventListener('click', () => openEventForm());
for (const id of ['#close-event', '#cancel-event']) $(id).addEventListener('click', () => $('#event-dialog').close());
$('#event-all-day').addEventListener('change', () => {
  const start = $('#event-start').value;
  const end = $('#event-end').value;
  const allDay = $('#event-all-day').checked;
  setDateTypes(allDay);
  $('#event-start').value = allDay ? start.slice(0, 10) : `${start.slice(0, 10)}T09:00`;
  $('#event-end').value = allDay ? end.slice(0, 10) : `${end.slice(0, 10)}T10:00`;
});
function eventDetails() {
  const allDay = $('#event-all-day').checked;
  if (!$('#event-start').value || !$('#event-end').value) throw new Error('Choose valid start and end dates.');
  const body = { title: $('#event-title').value, location: $('#event-location').value, description: $('#event-description').value, allDay,
    start: allDay ? $('#event-start').value : new Date($('#event-start').value).toISOString(),
    end: allDay ? shiftDay($('#event-end').value, 1) : new Date($('#event-end').value).toISOString() };
  if (!allDay) body.timeZone = localTimeZone;
  if (new Date(body.end) <= new Date(body.start)) throw new Error('End must be after start.');
  return body;
}
function resetAiNotes() {
  notesVersion++;
  notesRequest?.abort(); notesRequest = null;
  $('#generate-event-notes').disabled = false;
  $('#generate-event-notes').textContent = '✦ Generate with AI';
  $('#event-ai-status').hidden = true;
  $('#event-ai-preview').hidden = true;
}
for (const id of ['#event-title', '#event-start', '#event-end', '#event-location', '#event-description', '#event-all-day']) {
  $(id).addEventListener('input', resetAiNotes);
  $(id).addEventListener('input', resetTicket);
}
$('#event-dialog').addEventListener('close', resetAiNotes);
$('#event-dialog').addEventListener('close', resetTicket);
function resetTicket() {
  ticketVersion++;
  ticketRequest?.abort(); ticketRequest = null; ticketSuggestion = null;
  $('#read-event-ticket').disabled = false;
  $('#read-event-ticket').textContent = 'Read ticket PDF';
  $('#ticket-status').hidden = true;
  $('#ticket-preview').hidden = true;
}
$('#event-ticket').addEventListener('change', resetTicket);
$('#discard-ticket').addEventListener('click', resetTicket);
$('#read-event-ticket').addEventListener('click', async () => {
  resetTicket(); resetAiNotes();
  const version = ticketVersion;
  const status = $('#ticket-status');
  const errorBox = $('#event-form-error'); errorBox.hidden = true;
  try {
    const file = $('#event-ticket').files[0];
    if (!file || !/\.pdf$/i.test(file.name)) throw new Error('Choose a ticket PDF first.');
    if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Choose a PDF up to 5 MB.');
    $('#read-event-ticket').disabled = true;
    $('#read-event-ticket').textContent = 'Reading ticket…';
    status.textContent = 'Reading ticket details. Your event has not been changed.'; status.hidden = false;
    const pdf = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('The PDF could not be opened. Choose it again.'));
      reader.readAsDataURL(file);
    });
    if (version !== ticketVersion) return;
    ticketRequest = new AbortController();
    const result = await api('/api/events/import-ticket', { method: 'POST', body: JSON.stringify({ pdf, timeZone: localTimeZone }), timeoutMs: 115000, signal: ticketRequest.signal });
    if (version !== ticketVersion || !$('#event-dialog').open) return;
    ticketSuggestion = result.ticket;
    const ticket = ticketSuggestion;
    $('#ticket-details').textContent = [ticket.title || 'Title missing',
      `Start: ${ticket.start ? localInput(ticket.start).replace('T', ' ') : 'Not found — enter manually'}`,
      `End: ${ticket.end ? localInput(ticket.end).replace('T', ' ') : 'Not found — enter manually'}`,
      `Times displayed in ${localTimeZone}`, ticket.location, ticket.description,
      ...ticket.warnings.map(warning => `Review: ${warning}`)].filter(Boolean).join('\n\n');
    $('#ticket-preview').hidden = false;
    status.textContent = 'Review the extracted details. “Use ticket details” replaces the event fields; Save event adds them to Calendar.';
  } catch (error) {
    if (version !== ticketVersion) return;
    status.hidden = true; errorBox.textContent = error.message; errorBox.hidden = false;
  } finally {
    if (version === ticketVersion) { $('#read-event-ticket').disabled = false; $('#read-event-ticket').textContent = 'Read ticket PDF'; ticketRequest = null; }
  }
});
$('#apply-ticket').addEventListener('click', () => {
  if (!ticketSuggestion) return;
  const ticket = ticketSuggestion;
  resetTicket(); resetAiNotes();
  $('#event-title').value = ticket.title;
  $('#event-location').value = ticket.location;
  $('#event-description').value = ticket.description;
  $('#event-all-day').checked = false;
  setDateTypes(false);
  $('#event-start').value = ticket.start ? localInput(ticket.start) : '';
  $('#event-end').value = ticket.end ? localInput(ticket.end) : '';
  $('#ticket-status').textContent = 'Ticket details added. Check dates, times and any missing fields, then choose Save event.';
  $('#ticket-status').hidden = false;
});
$('#generate-event-notes').addEventListener('click', async () => {
  if (!$('#event-form').reportValidity()) return;
  resetAiNotes();
  const version = notesVersion;
  const button = $('#generate-event-notes');
  const status = $('#event-ai-status');
  const formError = $('#event-form-error'); formError.hidden = true;
  try {
    const details = eventDetails();
    notesRequest = new AbortController();
    button.disabled = true; button.textContent = '✦ Generating…';
    status.textContent = 'Writing a suggestion from your event details…'; status.hidden = false;
    const result = await api('/api/events/generate-notes', { method: 'POST', body: JSON.stringify(details), timeoutMs: 100000, signal: notesRequest.signal });
    if (version !== notesVersion || !$('#event-dialog').open) return;
    if (typeof result.notes !== 'string' || !result.notes.trim()) throw new Error('AI returned empty notes. Please try again.');
    $('#event-generated-notes').value = result.notes;
    $('#event-ai-preview').hidden = false;
    status.textContent = 'Review the suggestion, then choose “Use these notes”.';
    $('#event-ai-preview').scrollIntoView({ block: 'nearest' });
  } catch (error) {
    if (version !== notesVersion) return;
    status.hidden = true;
    formError.textContent = error.message; formError.hidden = false;
  } finally {
    if (version === notesVersion) { button.disabled = false; button.textContent = '✦ Generate with AI'; notesRequest = null; }
  }
});
$('#apply-event-notes').addEventListener('click', () => {
  $('#event-description').value = $('#event-generated-notes').value;
  resetAiNotes();
  $('#event-ai-status').textContent = 'Notes added. Choose Save event to save them to Google Calendar.';
  $('#event-ai-status').hidden = false;
});
$('#discard-event-notes').addEventListener('click', resetAiNotes);
$('#event-form').addEventListener('submit', async event => {
  event.preventDefault();
  resetTicket();
  resetAiNotes();
  $('#generate-event-notes').disabled = true;
  const button = $('#save-event'); button.disabled = true;
  $('#read-event-ticket').disabled = true;
  $('#close-event').disabled = $('#cancel-event').disabled = true;
  const formError = $('#event-form-error'); formError.hidden = true;
  try {
    const body = eventDetails();
    if (editingEvent) body.etag = editingEvent.etag;
    else body.requestId = eventRequestId;
    const result = await api(editingEvent ? `/api/events/${encodeURIComponent(editingEvent.id)}` : '/api/events', { method: editingEvent ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('#event-dialog').close();
    await load();
    const visible = upcomingEvents([result.event], new Date(), dashboard?.calendarWindowMonths || 12).length;
    notice(visible ? 'Event saved to Google Calendar.' : 'Event saved to Google Calendar. It is outside the upcoming calendar view.', false);
    chrome.runtime.sendMessage({ type: 'refresh' });
  } catch (error) { formError.textContent = error.message; formError.hidden = false; }
  finally { button.disabled = false; $('#generate-event-notes').disabled = false; $('#read-event-ticket').disabled = false; $('#close-event').disabled = $('#cancel-event').disabled = false; }
});
$('#event-dialog').addEventListener('cancel', event => { if ($('#save-event').disabled) event.preventDefault(); });
$('#refresh-calendar').addEventListener('click', event => action(event.currentTarget, async () => {
  await api('/api/events/refresh', { method: 'POST' }); await load();
  notice('Calendar refreshed.', false); chrome.runtime.sendMessage({ type: 'refresh' });
}));
$('#calendar-reconnect').addEventListener('click', event => action(event.currentTarget, async () => {
  const { url } = await api('/api/auth/url', { method: 'POST' }); await chrome.tabs.create({ url });
}));
$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#profile-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  inboxFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  });
  if (dashboard) render();
}));
$('#expand').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=expanded') }));
$('#connect').addEventListener('click', event => action(event.currentTarget, async () => {
  const { url } = await api('/api/auth/url', { method: 'POST' });
  await chrome.tabs.create({ url });
}));
$('#sync').addEventListener('click', event => action(event.currentTarget, async () => {
  await api('/api/sync', { method: 'POST' }); await load();
}));
$('#retry').addEventListener('click', event => action(event.currentTarget, async () => {
  await api('/api/retry-failed', { method: 'POST' }); await load();
}));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
  if ($('#content').querySelector('textarea[data-dirty="true"]') && !window.confirm('Discard unsaved draft edits?')) return;
  $('#content').replaceChildren();
  tab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button));
  if (dashboard) render();
}));
load();
const timer = setInterval(load, 5000);
window.addEventListener('pagehide', () => clearInterval(timer));
chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
