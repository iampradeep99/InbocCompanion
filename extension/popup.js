import { api, safeUrl } from './api.js';
import { upcomingEvents } from './calendar-utils.js';
import { mountEventDetails, fillEventDetails, readEventDetails, eventDetailsCard } from './event-details.js';

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
  const main = $('main');
  const scrollTop = main.scrollTop;
  const pageScrollTop = window.scrollY;
  const openEmails = new Set([...content.querySelectorAll('.email-card')]
    .filter(card => card.querySelector('details')?.open).map(card => card.dataset.emailId));
  const nextContent = document.createDocumentFragment();
  $('#section-title').textContent = { inbox: 'JOBS & DIRECT MESSAGES', drafts: 'READY FOR YOUR REVIEW', calendar: `THE NEXT ${dashboard.calendarWindowMonths || 12} MONTHS` }[tab];
  $('#section-note').textContent = tab === 'calendar' ? '15 min reminders' : tab === 'drafts' ? 'Saved in Gmail' : 'AI filtered';
  $('#mail-filters').hidden = tab !== 'inbox';
  $('#profile-prompt').hidden = tab !== 'inbox' || dashboard.jobProfileConfigured;
  $('#calendar-tools').hidden = tab !== 'calendar';
  $('#calendar-access').hidden = tab !== 'calendar' || !dashboard.connected || dashboard.calendarCanWrite;
  $('#new-event').disabled = !dashboard.connected || !dashboard.calendarCanWrite;
  $('#refresh-calendar').disabled = !dashboard.connected;
  const items = tab === 'calendar' ? currentEvents() : dashboard.emails.filter(e => tab === 'drafts' ? !!e.draftId || ['pending', 'uncertain'].includes(e.draftStatus) : !e.dismissed && (inboxFilter === 'all' || e.analysis.category === inboxFilter));
  if (!items.length) nextContent.append(element('div', 'empty', tab === 'calendar' ? `No upcoming events in the next ${dashboard.calendarWindowMonths || 12} months. Add something to look forward to.` : tab === 'drafts' ? 'Your reply drafts will appear here.' : 'All caught up. Relevant jobs and direct messages will appear here.'));
  for (const item of items) {
    const card = tab === 'calendar' ? eventCard(item) : emailCard(item);
    if (tab !== 'calendar' && openEmails.has(String(item.id))) card.querySelector('details').open = true;
    nextContent.append(card);
  }
  // Replace in one step so the five-second refresh never collapses the list and resets scrolling.
  content.replaceChildren(nextContent);
  main.scrollTop = scrollTop;
  window.scrollTo(window.scrollX, pageScrollTop);
}
function emailCard(email) {
  const card = element('article', 'card email-card');
  card.dataset.emailId = email.id;
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
  if (event.details) info.append(eventDetailsCard(event.details));
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
let eventSaving = false;
let eventRequestId;
let notesRequest = null;
let notesVersion = 0;
let ticketRequest = null;
let ticketVersion = 0;
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
  fillEventDetails(event?.details);
  $('#pdf-details-status').hidden = true;
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
  const body = { title: $('#event-title').value, location: $('#event-location').value, description: $('#event-description').value, details: readEventDetails(), allDay,
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
mountEventDetails(() => { resetAiNotes(); resetTicket(); });
function ticketBusy(busy) {
  $('#ticket-progress').hidden = !busy;
  $('#event-fields').disabled = busy || eventSaving;
  $('#save-event').disabled = busy || eventSaving;
  $('#ticket-import').setAttribute('aria-busy', String(busy));
}
function resetTicket() {
  ticketVersion++;
  ticketRequest?.abort(); ticketRequest = null;
  ticketBusy(false);
  $('#ticket-import').dataset.state = 'idle';
  $('#ticket-status').hidden = true;
  $('#ticket-preview').hidden = true;
  $('#retry-ticket').hidden = true;
  $('#ticket-file-name').hidden = true;
  $('#ticket-upload-title').textContent = 'Drop your ticket here';
  $('#ticket-upload-subtitle').textContent = 'or click to choose a PDF · fields fill automatically';
  document.querySelectorAll('.ticket-filled').forEach(field => field.classList.remove('ticket-filled'));
}
$('#cancel-ticket').addEventListener('click', resetTicket);
$('#retry-ticket').addEventListener('click', importSelectedTicket);
$('#event-ticket').addEventListener('change', importSelectedTicket);
const ticketDrop = $('#ticket-drop');
for (const type of ['dragenter', 'dragover']) ticketDrop.addEventListener(type, event => {
  event.preventDefault(); ticketDrop.classList.add('drag-over');
});
for (const type of ['dragleave', 'drop']) ticketDrop.addEventListener(type, event => {
  event.preventDefault(); ticketDrop.classList.remove('drag-over');
});
ticketDrop.addEventListener('drop', event => {
  if ($('#event-ticket').disabled || !event.dataTransfer.files.length) return;
  if (event.dataTransfer.files.length !== 1) {
    $('#ticket-status').textContent = 'Choose one ticket PDF at a time.'; $('#ticket-status').hidden = false; return;
  }
  $('#event-ticket').files = event.dataTransfer.files;
  importSelectedTicket();
});
async function importSelectedTicket() {
  resetTicket(); resetAiNotes();
  const version = ticketVersion;
  const status = $('#ticket-status');
  const errorBox = $('#event-form-error'); errorBox.hidden = true;
  const file = $('#event-ticket').files[0];
  if (!file) return;
  try {
    if (!/\.pdf$/i.test(file.name)) throw new Error('Choose a ticket PDF to fill your event.');
    if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Choose a PDF up to 5 MB.');
    ticketBusy(true);
    $('#ticket-import').dataset.state = 'processing';
    $('#ticket-upload-title').textContent = 'A little reading, a little magic';
    $('#ticket-upload-subtitle').textContent = 'Turning your ticket into an event…';
    $('#ticket-file-name').textContent = file.name; $('#ticket-file-name').hidden = false;
    $('#ticket-phase').textContent = 'Opening your PDF…';
    status.textContent = 'Processing ticket. Event fields will fill automatically.'; status.hidden = false;
    const pdf = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('The PDF could not be opened. Choose it again.'));
      reader.readAsDataURL(file);
    });
    if (version !== ticketVersion) return;
    $('#ticket-phase').textContent = 'Reading event, booking details, passengers & seats…';
    ticketRequest = new AbortController();
    const result = await api('/api/events/import-ticket', { method: 'POST', body: JSON.stringify({ pdf, timeZone: localTimeZone }), timeoutMs: 115000, signal: ticketRequest.signal });
    if (version !== ticketVersion || !$('#event-dialog').open) return;
    const ticket = result.ticket;
    resetAiNotes();
    fillEventDetails(ticket.details);
    $('#event-all-day').checked = false;
    setDateTypes(false);
    const fields = { '#event-title': ticket.title, '#event-location': ticket.location,
      '#event-description': ticket.description, '#event-start': ticket.start ? localInput(ticket.start) : '',
      '#event-end': ticket.end ? localInput(ticket.end) : '' };
    let filled = 1; // The category is also filled by AI.
    const category = $('#event-kind').selectedOptions[0].textContent;
    for (const field of document.querySelectorAll('#structured-details input, #event-kind')) {
      if (!field.value) continue;
      field.classList.add('ticket-filled');
      field.style.setProperty('--fill-delay', `${Math.min(filled, 10) * 70}ms`);
      if (field.id !== 'event-kind') filled++;
    }
    const detailCount = filled - 1;
    const detailsStatus = $('#pdf-details-status');
    detailsStatus.hidden = false;
    detailsStatus.textContent = detailCount
      ? `AI filled ${detailCount} detail fields from your PDF, including ${ticket.details?.passengers?.length || 0} passenger(s). Review the extracted values below.`
      : 'AI identified the category but could not read further structured details from this PDF. Check the source document or try a clearer text-based copy.';
    for (const [id, value] of Object.entries(fields)) {
      const field = $(id); field.value = value || '';
      if (value) { field.classList.add('ticket-filled'); field.style.setProperty('--fill-delay', `${filled++ * 70}ms`); }
    }
    const missing = [!ticket.title && 'title', !ticket.start && 'start time', !ticket.end && 'end time'].filter(Boolean);
    const warnings = ticket.warnings || [];
    $('#ticket-details').textContent = [...warnings, ...missing.map(name => `The ticket did not provide a clear ${name}. Enter it below.`), `Times displayed in ${localTimeZone}. Check the original ticket before saving.`].join('\n\n');
    $('#ticket-preview').hidden = false;
    $('#ticket-preview').open = missing.length > 0;
    $('#ticket-import').dataset.state = 'complete';
    $('#ticket-upload-title').textContent = 'Your ticket, now an event';
    $('#ticket-upload-subtitle').textContent = 'Choose another PDF to replace these details';
    status.textContent = `AI detected: ${category}. ` + (missing.length ? `${filled} fields filled. Add the missing ${missing.join(' and ')} below.` : `${filled} fields filled automatically. Review your event and save when ready.`);
  } catch (error) {
    if (version !== ticketVersion) return;
    $('#ticket-import').dataset.state = 'error';
    $('#ticket-upload-title').textContent = 'Let’s try that ticket again';
    $('#ticket-upload-subtitle').textContent = 'Choose another PDF or retry below';
    status.textContent = error.message; status.hidden = false;
    $('#retry-ticket').hidden = false;
  } finally {
    if (version === ticketVersion) { ticketBusy(false); ticketRequest = null; }
  }
}
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
  eventSaving = true;
  ticketBusy(false);
  const button = $('#save-event'); button.disabled = true;
  $('#event-ticket').disabled = true;
  $('#retry-ticket').disabled = true;
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
  finally { eventSaving = false; ticketBusy(false); button.disabled = false; $('#generate-event-notes').disabled = false; $('#event-ticket').disabled = false; $('#retry-ticket').disabled = false; $('#close-event').disabled = $('#cancel-event').disabled = false; }
});
$('#event-dialog').addEventListener('cancel', event => { if ($('#save-event').disabled && $('#ticket-import').dataset.state !== 'processing') event.preventDefault(); });
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
