import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { htmlToText } from 'html-to-text';

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
