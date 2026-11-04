# SmartNotes 2 — Email action assistant

The original SmartNotes app is the foundation. This version adds a task workspace, a local background server, read-only Gmail and Outlook connections, a Gemini email reader, and deadline reminders. The original `index.html`, `script.js`, and `style.css` are retained unchanged; open `index.html` separately to use the old browser-only app and export its notes.

## Run the working first version

Requires Node.js 22.13 or later.

```sh
npm ci
npm start
```

Open http://localhost:3000. Choose **Explore sample emails** to try assessment invitations, a project deadline, and a spam-folder suggestion. Samples are clearly labeled and do not connect to real mail. Manual tasks and notes work without any credentials.

Use **Settings → Import SmartNotes notes** to import your old JSON export. When original notes already exist on the same browser origin, the app offers an explicit import; it leaves the original local-storage copy intact. Browser data stored at another address is not automatically accessible.

## Connect actual accounts

Copy `.env.example` to `.env`. Keep `.env` private; it is ignored by Git. Restart the server after changing it.

1. Generate `ENCRYPTION_KEY` with the command in `.env.example`. Keep the same key across restarts: it encrypts saved account tokens. Losing it requires reconnecting accounts.
2. Set `GEMINI_API_KEY` and a Gemini model available to your account (`GEMINI_MODEL`). Only Gemini is implemented in this version; adding another provider means replacing the small `analyze()` adapter in `mail.js`. This does not connect to a consumer ChatGPT, Gemini or Claude subscription.
3. Create the Google/Microsoft OAuth app described below, add its credentials, then use **Connect an account**. You can connect multiple accounts of either provider.

### Gmail

- Create a Google Cloud project, enable the Gmail API, and configure OAuth consent.
- Create an OAuth client of type **Web application**.
- Register the exact redirect URI `http://localhost:3000/auth/gmail/callback`.
- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
- The app requests `openid`, `email`, and `https://www.googleapis.com/auth/gmail.readonly`.
- During consent-screen testing, add your account as a test user. Google's production verification requirements and testing token lifetimes apply; this code does not bypass them.
- Reference: https://developers.google.com/identity/protocols/oauth2/web-server

### Outlook / Microsoft 365

- Register an application in Microsoft Entra. Select supported account types matching your audience (use personal and organization accounts if both are needed).
- Add a **Web** redirect URI `http://localhost:3000/auth/outlook/callback`.
- Configure delegated Microsoft Graph `User.Read` and `Mail.Read` permissions; the sign-in flow also requests `openid`, `email`, and `offline_access`.
- Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. The default tenant is `common`; change `MICROSOFT_TENANT` for a tenant-specific app.
- Organizational policies may require administrator consent.
- Reference: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow

## What is implemented

- Gmail mail listing includes Spam and Promotions; Outlook reads incoming messages across mail folders, including Junk. Pagination is followed. Sent mail, drafts and trash are excluded. Initial lookback is **30 days**; subsequent syncs overlap the previous successful sync by one day. This is not a full historical mailbox import.
- Checks every five minutes while the server runs; **Check mail** triggers a manual check. Background reminders are checked each minute.
- The model reads the stored incoming context in a conversation, identifies one primary obligation, and extracts priority, deadline, confidence and a literal source quote. Dates without a clear timezone are supposed to be marked uncertain. All AI interpretations can be wrong and remain editable.
- Confident actions with a deadline can become active tasks automatically. Spam, low confidence, missing or ambiguous deadlines, completion suggestions and changes to completed/dismissed tasks require review.
- Follow-up messages update the same account/conversation task. Uncertain updates remain proposals, preserving the accepted deadline. Rejecting a proposal leaves the original task active. Completion from email always needs confirmation.
- Failed analyses are retried and appear under Needs review; one failure does not block all other conversations. Account connection failures are shown. Messages are not silently marked analyzed after failure.
- Tasks can be created, edited, completed, reopened, snoozed, searched and sorted by priority or deadline. Source emails are shown as text, never rendered as email HTML. Links open only the original mailbox, rather than arbitrary email-body links.
- Notes support editing, categories, color selection, search, JSON export and import; dark mode is retained. Notes and tasks persist across server restarts.

## Reminders and alerts

New email actions create a notification. Active tasks receive reminders at 24 hours, one hour, and overdue. If the server was offline, only the relevant catch-up threshold is emitted. Deadline changes generate new reminder keys; obsolete pending reminder pushes are suppressed. Completed tasks stop receiving deadline reminders.

Enable **Settings → Enable browser notifications** for Web Push. Push keys are generated locally and stored in ignored `data/push.json`. Subscription support includes Chrome/Edge, Firefox and Safari push services. Actual support depends on browser/device permissions, secure-context rules, browser background behavior, and push-service availability. On iOS, home-screen installation may be required. Audible alarms cannot override the operating system's silent or focus mode. Optional in-tab sound requires a user gesture. Push delivery is best effort and is not an alarm-clock guarantee.

The Node server must stay running for mail checks and reminders, even if the browser tab is closed. This is not a mobile background service. First enable notifications, then create a task due in a few minutes to test delivery on your device. A supported device and real credentials are needed to validate the external integrations end to end.

## Data, privacy and deployment boundary

This is a **single-user, local-first MVP**, bound to `127.0.0.1`. It is not a hosted multi-user service. It has OAuth state, PKCE, read-only mailbox scopes, same-origin mutation checks, strict new-dashboard CSP, token encryption, a static-file allowlist, and no secrets in browser responses. These controls are not a substitute for production user authentication or per-user data isolation.

Email text is sent to your configured Gemini API account for analysis. Account tokens are encrypted at rest. Email bodies, tasks, notes and push keys are saved in the local ignored `data/` directory, which must be protected and backed up appropriately. Data export includes email text and account addresses, but not tokens or push subscriptions. Disconnecting removes the app's local account credentials and that account's imported emails/tasks. You can separately revoke consent in Google or Microsoft account settings.

Do not expose this server to the public Internet. A public product needs user authentication, per-user storage/authorization, protected secret management, provider verification, a persistent job runner/queue, backup and retention policies, consent/deletion UX, rate limiting, production monitoring, and real-device push tests. Node's local server and filesystem state do not run on static GitHub Pages or directly on Sites' Worker runtime. No public deployment is included with this branch.

Known scope limits: one primary task per conversation; no attachments/OCR; no Yahoo/IMAP; no extraction of assessment URLs into clickable task links (the original email remains available); no guarantee that every important email is detected. Multiple obligations are routed to review by the prompt rather than automatically split. Threads predating the initial lookback can have incomplete context. Notifications use a single-user shared list, with best-effort retry rather than guaranteed delivery receipts.

## Verify

See [TESTING.md](TESTING.md) for the automated case inventory, live AI evaluation corpus, and manual release matrix. Expanded regression fixes include strict calendar dates, confidence types, idempotent reanalysis, cancellation review, preserved manual edits during in-flight AI requests, per-device push retries, refresh-token preservation, safe import/storage handling and non-destructive corrupt-file startup failure.

```sh
npm run check
npm test
```

Tests cover deadline revisions, uncertainty and spam review, account separation, literal source evidence, reminder deduplication/snooze, persistence, imports/notes API, origin protection, and credential filtering. Gmail/Outlook/Gemini and device push require a configured live smoke test. Browser visual QA may need a host-visible local preview; an isolated execution environment can run the API tests even when the desktop browser cannot reach its loopback port.
