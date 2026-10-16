# Inbox Companion

A Manifest V3 Chrome extension with a local Node.js / Express backend for Gmail and Google Calendar. NVIDIA's OpenAI-compatible endpoint runs `openai/gpt-oss-20b` to identify important emails and prepare replies.

## What it does

- Reads recent inbox messages and shows only job opportunities that strongly match your saved profile, plus direct personal/work correspondence from people. OTPs, verification mail, promotions, newsletters, and unrelated automated alerts are excluded.
- Generates replies for relevant messages that need a response, and saves them as **Gmail drafts**. You can edit and save a draft from the extension or review it in Gmail. Sending happens manually in Gmail.
- Shows the next 12 calendar months from your primary Google Calendar, including recurring and all-day events. Create, edit, and delete events directly in the extension. Past events disappear from the upcoming list after their end time; Google Calendar retains their history unless you explicitly delete them.
- Displays a toolbar badge and desktop reminders approximately 15 minutes before timed events. All-day reminders appear once from 9am in your computer's timezone.
- Continues backend checks every five minutes; Chrome checks for reminders every minute. The backend must run for syncing, and Chrome must run for reminders. Sleeping computers can delay or miss reminders.

## 1. Install and configure the backend

Use **Node.js 22 or newer**. The workspace's original Node.js 18 is too old for the current provider SDKs.

```bash
npm ci
npm run setup
```

Open `.env` and fill in:

```dotenv
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
NVIDIA_API_KEY=your-nvidia-api-key
```

`npm run setup` generates `API_TOKEN` (for pairing the extension) and `ENCRYPTION_KEY` (for local encrypted storage). Keep `.env` private. Keep the encryption key stable: changing it makes existing local data unreadable. The NVIDIA key is the actual key value, without a `$` prefix. There is no key in the extension bundle.

## 2. Configure Google OAuth

1. Create or choose a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Gmail API** and **Google Calendar API** in that project.
3. Configure the Google Auth Platform consent screen. For a personal development app, choose an External testing audience and add your Gmail address as a test user. Internal is available for eligible Workspace organizations.
4. Add these data access scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/calendar.events`
5. Create an OAuth client of type **Web application**. Add this exact **Authorized redirect URI**:

   ```text
   http://127.0.0.1:3210/auth/google/callback
   ```

6. Copy the client ID and secret into `.env`. Start the backend:

   ```bash
   npm start
   ```

By default the server binds to `127.0.0.1:3210`. `localhost` and `127.0.0.1` are different OAuth redirect URIs, so use the exact URI above. If you change the local port, update `PORT`, `GOOGLE_REDIRECT_URI`, Google's redirect allowlist, and the extension's backend address together.

Google's compose scope also permits sending mail, although this app exposes only create/update draft operations. Testing-mode Google refresh tokens for these scopes can expire after seven days; reconnect when prompted. Public distribution requires your own Google verification and privacy-policy work. See [Google's web server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

## Deploy the backend on Render (optional)

For a Render **Web Service**, use Node 22+, build command `npm install`, start command `npm start`, and health check path `/health`. Render startup automatically binds to `0.0.0.0` on its `PORT` and uses `RENDER_EXTERNAL_URL` for the allowed hostname and default Google OAuth callback. Local startup still binds to loopback. `HOST` overrides the binding; remove a localhost `HOST` override on Render.

1. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NVIDIA_API_KEY`, `API_TOKEN` (at least 32 characters), and `ENCRYPTION_KEY` (64 hexadecimal characters) in Render's environment settings. Keep these secrets stable and use your own strong random pairing token and key.
2. Add `https://YOUR-SERVICE.onrender.com/auth/google/callback` to your Google OAuth client's authorized redirect URIs. Remove a local `GOOGLE_REDIRECT_URI` override from Render, or set it to this exact HTTPS callback.
3. Attach a persistent disk mounted at `/var/data` and set `DATA_DIR=/var/data`. Run one service instance: encrypted state is stored in a single file. Without persistent storage, redeploys can lose the Google connection and cached data.
4. Redeploy, reload the unpacked extension at `chrome://extensions` to apply its updated permissions, and enter `https://YOUR-SERVICE.onrender.com` as its backend address. Pair using Render's `API_TOKEN`, then connect Google.

`PUBLIC_URL` can override the public HTTPS origin for server configuration. The bundled extension supports local loopback and HTTPS `*.onrender.com` addresses; custom domains also require updating its address validation, host permissions, and connection policy.

## 3. Load and pair the Chrome extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this project's **`extension`** directory.
3. Pin **Inbox Companion** to the Chrome toolbar. Open it and click the settings gear.
4. Keep the backend address as `http://127.0.0.1:3210`. Paste `API_TOKEN` from `.env` into **Pairing token**, then click **Save & test connection**.
5. Click **Connect / reconnect Google**, sign in, and allow all three requested permissions. This authorizes analysis of matching email content by NVIDIA and automatic saving of reply drafts in Gmail.
6. Return to the extension. The first sync starts automatically. **Sync now** starts another pass; results appear as processing completes.

In Settings, fill in **Resume summary & job preferences** with target roles, skills, experience, location/remote preferences, and any must-haves. Save it to recheck the inbox. You can paste the relevant parts of your resume; PDF/DOCX upload is not built into the extension. Contact details are not needed. Without a profile, job opportunities are hidden while direct messages still appear. The **For you** view has **All matches**, **Job matches**, and **Direct messages** filters. Use **Expand** to open the full dashboard.

No Chrome OAuth client ID or extension ID needs to be configured. The backend handles the OAuth callback with a short-lived, one-use state token. One Google account is supported at a time.

## Settings and behavior

| Setting in `.env` | Default | Meaning |
| --- | --- | --- |
| `NVIDIA_MODEL` | `openai/gpt-oss-20b` | NVIDIA model identifier |
| `POLL_MINUTES` | `5` | Backend sync frequency |
| `MAX_EMAILS_PER_SYNC` | `20` | Maximum new messages analyzed per pass |
| `GMAIL_QUERY` | `in:inbox newer_than:7d` | Gmail search query; includes read/unread messages and job alerts in any inbox category |
| `CALENDAR_ID` | `primary` | Calendar ID to read; use another calendar's ID if needed |
| `CALENDAR_MONTHS` | `12` | Calendar lookahead in calendar months, configurable from 1 to 24; replaces `CALENDAR_DAYS` |

Each pass pages through up to 500 matching messages and processes up to the configured limit of new messages. Only the latest non-draft message in each thread is considered; threads whose latest message is outgoing are skipped. Reading does not mark mail read or archive it. Each message is analyzed once per profile/filter version. Profile changes hide stale results and trigger rechecks in later passes, preserving existing Gmail drafts and manual edits. Failed analysis retries up to three times, with a manual **Retry failed emails** control afterward. The previous default query excluding promotions/social is automatically widened so job alerts are not skipped before AI review; other custom queries are preserved.

Direct messages appear even if they are not urgent and may have no draft. Recruiter outreach is classified as job mail and must match the profile. Jobs are compared by role, skills, experience, location, and remote preference; weak/unknown matches and explicit conflicts are hidden. A matching job-site digest can appear without a reply draft. No-reply, mailing-list, and auto-submitted messages never get automatic reply drafts. A strong match is a model judgment, not a guarantee. AI can misclassify messages and generate incorrect content: review the actual email and every draft before sending. Unknown facts should appear as placeholders.

Saved drafts are reconciled with Gmail on later syncs. Drafts sent or deleted in Gmail disappear from the draft view. Ambiguous save results are checked using a stable message marker; the app avoids blind retries that could create duplicates. If a save stays unconfirmed, check Gmail Drafts and copy the proposed text manually if needed. New important messages and upcoming reminders count toward the toolbar badge; **Dismiss** clears a message from the extension's priority view without altering Gmail.

## Calendar management

Open **Calendar → New event** to enter a title, start/end, optional location, and notes. Timed entries use the computer’s displayed timezone. All-day forms use an inclusive **Last day**; the backend converts it to Google’s exclusive end date. **Edit** appears for supported editable events, and **Delete** asks for confirmation before removing the event from Google Calendar. For recurring events, edits/deletions affect only the displayed occurrence. Existing attendee lists, meeting links, and recurrence rules are preserved by partial updates; this editor does not add guests and requests no guest-update emails (`sendUpdates=none`).

**Generate with AI** beside Notes uses the event title, dates, location, and any rough notes/definition to suggest a description or preparation checklist. Review/edit the preview and choose **Use these notes**, then **Save event** to persist it. Generation alone never modifies Google Calendar or replaces your existing notes. Changing the event details clears an old suggestion; closing the form cancels generation.

**Import ticket PDF** in the event form accepts a text-based ticket PDF up to 5 MB and 10 pages. Choose a file and click **Read ticket PDF**. The backend reads its text and sends it to NVIDIA to extract a title, departure/start and arrival/end, location, and available details such as PNR, train/flight number, passenger, seat/coach, and boarding instructions. Review the preview, choose **Use ticket details**, correct or complete the fields, and click **Save event**. Applying replaces the event fields; extraction alone never changes Calendar. Missing/ambiguous dates or times remain blank. Times display in your computer's timezone; source times and timezone assumptions appear in the preview/notes. Multiple journeys use the first event with a warning. Scanned/image-only or password-protected PDFs need an unlocked text copy or manual entry; OCR is not included.

Uploaded ticket PDFs are processed temporarily and are not stored or attached to Calendar. Their extracted text (including any booking/passenger information) is sent to NVIDIA. Only the details you apply and save become event data. Deploy the backend changes with `npm install` and reload the updated Chrome extension to enable ticket import.

Existing installations must **Reconnect Google** and allow Calendar editing: the previous read-only token can still list events but cannot modify them. The calendar view shows a reconnect prompt until this permission is granted. New connections request `calendar.events` instead of `calendar.events.readonly`. If Google requires it, add the new scope in Google Auth Platform → Data access as well.

The list looks ahead exactly 12 calendar months by default, with leap-day/month-end handling and paginated recurring instances. Events disappear from the extension after their end time; ongoing events remain. All-day expiry follows the calendar’s timezone. Expiry does not delete Google history. **Refresh calendar** works independently of an inbox AI scan. Writes and refreshes serialize so an old fetch cannot resurrect a deleted event. Stable create IDs prevent duplicate events when retrying a lost response, and event versions prevent edits/deletions from silently overwriting changes made elsewhere. A version conflict requires refreshing and reopening the event.

## Privacy and local data

Your saved job profile plus matching emails' sender, subject, and up to 16,000 body characters are sent to `https://integrate.api.nvidia.com/v1`. Email attachments are not sent to the AI. **Generate with AI** sends the event form's title, dates, location, and rough notes. **Read ticket PDF** sends text extracted from the PDF you select, including available booking/passenger details. The rest of your calendar and your job profile are not included in these event requests. The AI's final structured result is validated; reasoning traces are not stored or shown. Email and ticket text are treated as untrusted input and displayed as plain text.

OAuth tokens, your job profile, fetched email bodies, analysis, draft text, and calendar events are saved in `data/assistant.enc.json`, encrypted with AES-256-GCM using `ENCRYPTION_KEY`. The app does not automatically expire processed email records; **Disconnect & clear local data** removes the local account/cache and attempts to revoke Google access. Existing Gmail drafts remain in Gmail. For offline removal, stop the backend and delete `data/`; revoke app access in your Google Account separately if needed. Losing `.env`'s encryption key requires resetting `data/` and reconnecting.

The extension stores the pairing token and reminder history in Chrome local storage. API calls require this token. The backend rejects ordinary website origins and unrecognized hostnames. This is a single-user application. With Render hosting, encrypted backend data resides on Render; use the HTTPS service URL and keep the pairing token private.

## Development and verification

```bash
npm run check
npm test
```

Checks cover JavaScript syntax and manifest file references. Tests exercise MIME/Unicode replies, AI validation, encrypted persistence, concurrency, duplicate prevention, pagination, provider failures, API authentication/origin checks, draft edits, and reminder windows. Tests use mocked Google/NVIDIA providers and make no real account changes. Running integration tests requires permission to bind a local loopback port.

Optional browser verification loads the real unpacked extension in an isolated Chromium profile with fake provider data:

```bash
npx playwright install chromium --no-shell
npm run test:browser
```

This checks pairing, job-profile settings, inbox filters, editing/saving drafts, calendar links, Calendar permission prompts, event creation/editing/deletion, all-day conversion, a 12-month lookahead, hiding past events, dismissal, notifications, reminder deduplication, badges, and disconnect. It writes a sample-data screenshot to `docs/extension-preview.png`.

The implementation follows [Gmail's draft guide](https://developers.google.com/workspace/gmail/api/guides/drafts), [Calendar event listing](https://developers.google.com/calendar/api/v3/reference/events/list), [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms), and [NVIDIA's model reference](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b).

## Troubleshooting

- **Backend unavailable:** run `npm start` using Node 22+, and verify the address/port in Settings.
- **Pairing token invalid:** copy `API_TOKEN`, not `NVIDIA_API_KEY`, into extension Settings.
- **redirect_uri_mismatch:** ensure the exact `http://127.0.0.1:3210/auth/google/callback` is configured on the Web application OAuth client.
- **Access blocked / insufficient permissions:** add yourself as a test user, enable both Google APIs, reconnect, and allow every requested permission. Workspace administrators may restrict these scopes.
- **Google authorization expired:** reconnect in Settings. An external testing-mode app may require this weekly.
- **AI errors / rate limit:** verify your NVIDIA key/model access and quota. Use **Retry failed emails** after correcting the configuration.
- **Missing reminders:** keep Chrome and the backend running, enable reminders in Settings, allow Chrome notifications in your operating system, and check for calendar sync errors. Calendar data older than 15 minutes does not trigger reminders.
