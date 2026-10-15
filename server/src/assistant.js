import { canReply } from './mail.js';
import { jobProfile, relevanceKey, applyRelevance } from './relevance.js';
import { upcomingEvents } from '../../extension/calendar-utils.js';

export function friendlyError(error) {
  const status = Number(error.status || error.code || error.response?.status);
  if (error.provider === 'NVIDIA' && status === 401) return 'NVIDIA rejected the API key. Check NVIDIA_API_KEY in .env and restart the backend.';
  if (status === 401 || /invalid_grant/i.test(error.message || '')) return 'Google authorization expired or was revoked. Reconnect your account.';
  if (status === 403) return 'Access denied. Check Google API enablement, consent permissions, and NVIDIA key access.';
  if (status === 429) return 'Provider rate limit reached. The next sync will retry.';
  if (error.name === 'ZodError' || error instanceof SyntaxError) return 'AI returned an invalid result. The next sync will retry.';
  if (status >= 500) return 'A provider is temporarily unavailable. The next sync will retry.';
  return 'Sync could not complete. Check credentials, connection, and backend configuration.';
}

export class Assistant {
  constructor({ store, google, analyze, query, maxEmails, calendarMonths = 12 }) {
    Object.assign(this, { store, google, analyze, query, maxEmails, calendarMonths });
    this.running = null;
    this.calendarTail = Promise.resolve();
    this.calendarBusy = 0;
    this.abortController = new AbortController();
  }
  stop() { this.stopping = true; this.abortController.abort(); }
  async settleAccountWork() {
    this.abortController.abort();
    if (this.running) await this.running.catch(() => {});
    await this.calendarTail;
  }
  withCalendar(task) {
    this.calendarBusy++;
    const result = this.calendarTail.then(task);
    this.calendarTail = result.catch(() => {});
    return result.finally(() => { this.calendarBusy--; });
  }
  refreshCalendar() {
    if (this.calendarRefresh) return this.calendarRefresh;
    this.calendarRefresh = this.withCalendar(async () => {
      this.store.data.events = upcomingEvents(await this.google.getEvents(), new Date(), this.calendarMonths);
      this.store.data.calendarUpdatedAt = new Date().toISOString();
      this.store.save();
    }).finally(() => { this.calendarRefresh = null; });
    return this.calendarRefresh;
  }
  saveEvent(input, id) {
    return this.withCalendar(async () => {
      const event = await this.google.saveEvent(input, id);
      this.store.data.events = upcomingEvents([...this.store.data.events.filter(e => e.id !== event.id), event], new Date(), this.calendarMonths);
      this.store.data.calendarUpdatedAt = new Date().toISOString();
      this.store.save();
      return event;
    });
  }
  deleteEvent(id, etag) {
    return this.withCalendar(async () => {
      await this.google.deleteEvent(id, etag);
      this.store.data.events = this.store.data.events.filter(event => event.id !== id);
      this.store.data.calendarUpdatedAt = new Date().toISOString();
      this.store.save();
    });
  }
  sync() {
    if (this.stopping || this.accountChanging || !this.store.data.account || !this.store.data.tokens) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    this.store.data.errors = [];
    try {
      await this.refreshCalendar();
    } catch (error) { this.store.data.errors.push(`Calendar: ${friendlyError(error)}`); }
    try {
      let pageToken;
      let examined = 0;
      // Page past processed emails, with a bounded 500-message lookback per scan.
      for (let page = 0; page < 10 && examined < this.maxEmails; page++) {
        if (this.stopping || this.accountChanging) return;
        const result = await this.google.listMessages(this.query, pageToken);
        for (const metadata of result.messages || []) {
          if (this.stopping || this.accountChanging) return;
          const profile = jobProfile(this.store.data);
          const contextKey = relevanceKey(profile);
          const existing = this.store.data.emails[metadata.id];
          if ((existing?.analysis && existing.contextKey === contextKey) || existing?.skipped
            || (existing?.attemptContext === contextKey && existing.attempts >= 3)) continue;
          if (examined >= this.maxEmails) break;
          examined++;
          try {
            const email = await this.google.getLatestEmail(metadata.id, metadata.threadId);
            if (!email) { this.store.data.emails[metadata.id] = { id: metadata.id, skipped: true }; continue; }
            let analysis;
            try { analysis = await this.analyze(email, this.store.data.account, profile, { signal: this.abortController.signal }); }
            catch (error) { error.provider = 'NVIDIA'; throw error; }
            // Profile edits may arrive during an AI request. Never publish its stale result.
            if (this.stopping || this.accountChanging) return;
            if (contextKey !== relevanceKey(jobProfile(this.store.data))) continue;
            analysis = applyRelevance(analysis, email, this.store.data.account, profile);
            const record = { ...existing, ...email, analysis, contextKey, attempts: 0, analysisError: null,
              processedAt: new Date().toISOString(), dismissed: existing?.dismissed || false,
              draftStatus: existing?.draftStatus || 'none', draftText: existing?.draftId ? existing.draftText : analysis.draft };
            this.store.data.emails[email.id] = record;
            this.store.save();
            if (analysis.important && analysis.needsReply && record.draftStatus === 'none' && canReply(email, this.store.data.account)) {
              // Persist intent before external write. Ambiguous results are reconciled,
              // never blindly retried, to prevent duplicate drafts after a restart.
              record.draftStatus = 'pending'; this.store.save();
              try {
                record.draftId = await this.google.saveDraft(email, analysis.draft);
                record.draftStatus = 'saved';
              } catch {
                record.draftStatus = 'uncertain';
                record.error = 'Draft save could not be confirmed. Check Gmail Drafts; reconciliation runs on the next sync.';
              }
              this.store.save();
            }
          } catch (error) {
            if (this.stopping || this.accountChanging) return;
            this.store.data.emails[metadata.id] = { ...existing, id: metadata.id,
              attempts: (existing?.attemptContext === contextKey ? existing.attempts || 0 : 0) + 1,
              attemptContext: contextKey, analysisError: friendlyError(error) };
            this.store.save();
          }
        }
        pageToken = result.nextPageToken;
        if (!pageToken) break;
      }
      for (const email of Object.values(this.store.data.emails)) {
        if (this.stopping || this.accountChanging) return;
        if (email.draftStatus === 'saved' && email.draftId) {
          const draft = await this.google.getDraft(email.draftId);
          if (draft) email.draftText = draft.text;
          else { email.draftStatus = 'removed'; email.draftId = null; }
        }
        if (!['pending', 'uncertain'].includes(email.draftStatus)) continue;
        const draftId = await this.google.findDraft(email);
        if (draftId) { email.draftId = draftId; email.draftStatus = 'saved'; delete email.error; }
        else {
          email.draftStatus = 'uncertain';
          email.error = 'Draft save is unconfirmed. Check Gmail Drafts. No automatic duplicate will be created.';
        }
      }
      this.store.data.inboxUpdatedAt = new Date().toISOString();
    } catch (error) { this.store.data.errors.push(`Inbox: ${friendlyError(error)}`); }
    this.store.data.lastSync = new Date().toISOString();
    this.store.save();
  }
  dashboard() {
    const data = this.store.data;
    const profile = jobProfile(data);
    const contextKey = relevanceKey(profile);
    return {
      connected: !!data.account && !!data.tokens, account: data.account, syncing: !!this.running,
      lastSync: data.lastSync, inboxUpdatedAt: data.inboxUpdatedAt, calendarUpdatedAt: data.calendarUpdatedAt,
      errors: data.errors,
      jobProfileConfigured: !!profile,
      calendarWindowMonths: this.calendarMonths,
      calendarCanWrite: !!this.google.canWriteEvents?.(),
      failedEmails: Object.values(data.emails).filter(e => e.attemptContext === contextKey && e.analysisError).map(e => ({ id: e.id, error: e.analysisError, attempts: e.attempts })),
      emails: Object.values(data.emails).filter(e => e.contextKey === contextKey && e.analysis?.important).sort((a, b) => b.date.localeCompare(a.date)),
      events: upcomingEvents(data.events, new Date(), this.calendarMonths)
    };
  }
}
