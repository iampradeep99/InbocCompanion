import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { htmlToText } from 'html-to-text';
import { detailsSummary } from './event-details.js';

const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export async function buildEventEmail(event, account, recipient, messageId, kind) {
  const timeZone = event.start.timeZone || event.calendarTimeZone || 'Asia/Kolkata';
  const format = value => value.dateTime
    ? new Intl.DateTimeFormat('en-IN', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(value.dateTime))
    : `${value.date} (all day)`;
  const heading = kind === 'confirmation' ? 'Your event is saved' : 'Your event is coming up';
  const end = event.end.date ? `${new Date(Date.parse(event.end.date) - 86400000).toISOString().slice(0, 10)} (last day)` : format(event.end);
  const facts = [['Event', event.title], ['Starts', format(event.start)], ['Ends', end], ['Timezone', timeZone],
    ['Location', event.location], ['Meeting link', event.meetingUrl]].filter(([, value]) => value);
  const details = event.details ? detailsSummary(event.details).trim() : '';
  const schedule = 'Reminders: every 2 days before the event day; every 2 hours from 8am on the event day; and 3, 2 and 1 hour before the start. Reminders stop when the event starts. All-day events use 9am as the reminder cutoff.';
  const url = /^https:\/\/(?:calendar\.google\.com|www\.google\.com)\//.test(event.url || '') ? event.url : '';
  const text = `${heading}\n\n${facts.map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n${event.description || ''}\n${details}\n\n${url ? `Google Calendar: ${url}\n\n` : ''}${schedule}\n\nTo change the recipient or stop emails, edit this event in Inbox Companion and turn off email reminders.\nInbox Companion`;
  const html = `<!doctype html><html><body style="margin:0;background:#eef4f0;font-family:Arial,sans-serif;color:#111"><table role="presentation" style="width:100%;max-width:640px;margin:24px auto;border-collapse:collapse;background:#fff;border:1px solid #c8d8cf"><tr><td style="padding:28px;background:#06452f;color:#fff"><div style="font-size:12px;letter-spacing:2px">INBOX COMPANION</div><h1 style="font-size:25px;margin:12px 0 0">${escapeHtml(heading)}</h1></td></tr><tr><td style="padding:28px"><h2 style="margin-top:0;color:#111">${escapeHtml(event.title)}</h2><table style="width:100%;border-collapse:collapse">${facts.map(([key, value]) => `<tr><th style="padding:10px 12px 10px 0;text-align:left;vertical-align:top;border-bottom:1px solid #dce7df">${escapeHtml(key)}</th><td style="padding:10px 0;border-bottom:1px solid #dce7df;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`).join('')}</table>${event.description ? `<h3>Notes</h3><p style="white-space:pre-wrap;line-height:1.7">${escapeHtml(event.description)}</p>` : ''}${details ? `<h3>Booking & event details</h3><p style="white-space:pre-wrap;line-height:1.8">${escapeHtml(details)}</p>` : ''}${url ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#06452f;color:#fff;padding:13px 20px;text-decoration:none;border-radius:6px">Open Google Calendar</a></p>` : ''}<p style="font-size:12px;line-height:1.7;padding:16px;background:#eff5f1">${escapeHtml(schedule)}</p><p style="font-size:12px;line-height:1.7">To change the recipient or stop emails, edit this event in Inbox Companion and turn off email reminders.</p></td></tr></table></body></html>`;
  return (await new MailComposer({ from: { address: account }, to: [{ address: recipient }],
    subject: `${kind === 'confirmation' ? 'Event saved' : 'Event reminder'}: ${event.title}`,
    messageId: `<${messageId}>`, headers: { 'Auto-Submitted': 'auto-generated' }, text, html }).compile().build()).toString('base64url');
}

export async function parseEmail(raw, metadata) {
  const parsed = await simpleParser(Buffer.from(raw, 'base64url'), { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true });
  const recipient = parsed.replyTo?.value?.[0]?.address || parsed.from?.value?.[0]?.address || '';
  return {
    id: metadata.id, threadId: metadata.threadId,
    from: parsed.from?.text || '', recipient,
    subject: parsed.subject || '(No subject)',
    body: parsed.text || htmlToText(parsed.html || '', { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] }),
    messageId: parsed.messageId || '', references: parsed.references || [],
    date: parsed.date?.toISOString() || new Date(Number(metadata.internalDate) || Date.now()).toISOString(),
    gmailImportant: (metadata.labelIds || []).includes('IMPORTANT'),
    autoSubmitted: String(parsed.headers.get('auto-submitted') || '').toLowerCase(),
    listMessage: parsed.headers.has('list-unsubscribe') || parsed.headers.has('list-id')
  };
}

export function canReply(email, account) {
  return !!email.recipient && email.recipient.toLowerCase() !== account.toLowerCase()
    && !/(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer-daemon)@/i.test(email.recipient)
    && !email.listMessage && (!email.autoSubmitted || email.autoSubmitted === 'no');
}

export async function buildReply(email, account, text) {
  if (!canReply(email, account)) throw new Error('This message cannot receive an automatic reply draft.');
  const subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`;
  const references = [...new Set([...(Array.isArray(email.references) ? email.references : [email.references]), email.messageId].filter(Boolean))];
  const composer = new MailComposer({
    from: { address: account }, to: [{ address: email.recipient }], subject,
    text, inReplyTo: email.messageId || undefined, references,
    // Stable marker permits reconciliation after a lost Gmail create response.
    messageId: `<inbox-companion-${email.id}@local.invalid>`
  });
  return (await composer.compile().build()).toString('base64url');
}
