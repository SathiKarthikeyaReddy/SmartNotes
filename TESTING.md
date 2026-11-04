# SmartNotes test plan

This plan covers the new email-action workspace. No finite suite can cover every possible email, browser, account policy or failure. Automated service doubles prove our code's handling of responses; they do not prove Google's, Microsoft's, Gemini's or a phone's real behavior.

## Repeatable commands

```sh
npm ci
npm run check
npm test
npm run test:coverage
npm run test:report > test-results.json
```

Node 22.13+ is required. `jsdom` is a development-only dependency. Tests create isolated disposable directories under `data/tests`, launch loopback servers on random ports, and use synthetic mail. Test service doubles are imported only into test child processes; production has no test endpoints or service-override flags.

## Automated cases

The generated test-results report lists every executed test by name, file and result. Coverage is split across:

| File | Scope |
| --- | --- |
| `test/core.test.js` | Original task policies, reminders, evidence and ordering |
| `test/core-edge.test.js` | AI output type validation; date/time/Unicode boundaries; literal evidence; confidence; mixed-account/thread guards; idempotence; cancellation; review; 10,000 reminder checks; clock reversal; saved-state schema |
| `test/mail.test.js` | Provider pagination, folders, token encryption and refresh |
| `test/mail-edge.test.js` | Tamper/wrong-key rejection; malformed OAuth responses; token rotation; HTTP failures; network outage; timeouts/redirects; Gmail MIME/attachments; empty mail; page cycles/duplicates; incremental overlap; Outlook continuation safety; empty/blocked/malformed AI output; prompt data boundary |
| `test/server.test.js` | Initial integration regression test and restart persistence |
| `test/server-edge.test.js` | Static-file access; headers/origin/host checks; malformed/large JSON; task/note CRUD; state transitions; size limits; concurrency; settings; subscriptions; credential filtering |
| `test/flows.test.js` | Server + simulated Gmail + simulated AI + simulated push: independent failure/retry, unchanged syncs, deadline revisions, manual-edit race, completion approval, outages, sync lock, account deletion, OAuth state/PKCE/expiry/session/replay/reconnect, per-device delivery retry |
| `test/client.test.js` | Actual dashboard script in a DOM: navigation, filtering, forms, errors, imports, hostile source text, link restrictions, notes, exports, preferences, storage failures, notifications, push registration and optional audio |
| `test/worker.test.js` | Push payload handling, malformed data fallback, click-to-focus/open and hostile redirect rejection |
| `test/persistence.test.js` | Corrupt saved files stop startup without modification; 10,000-task sorting; seeded 200-task reminder simulation |

Malformed test fixtures were corrected separately from product defects: the snooze-boundary fixture initially placed the deadline outside any reminder window; Node's fetch did not transmit the test's custom Host header, so that test now uses a raw HTTP request; Windows preload paths use file URLs. These corrections do not relax product expectations.

## Live model evaluation — not part of the mocked tests

`test-data/ai-cases.json` contains 24 synthetic scenarios: assessments, projects, interviews, missing/ambiguous dates, multiple obligations, newsletters, advertisements, tasks assigned to someone else, acknowledgments, extensions, shortened deadlines, cancellation, completion, spam, prompt injection, Unicode, conflicting dates, DST ambiguity, invalid calendar dates and quoted outdated deadlines.

With a server-side `GEMINI_API_KEY` configured:

```sh
npm run test:ai:live
```

This deliberately requires the explicit live command. It sends synthetic emails to Gemini and incurs API usage. It records model/version/time, expected-field mismatches and errors in `data/ai-evaluation.json`. Run it several times to assess nondeterminism; a single pass is not evidence of perfect classification. No real personal emails are needed.

## Manual/live release matrix

All rows below require execution in the stated environment. They must not be reported as passed from mocked tests.

| ID | Scenario | Expected result | Needs |
| --- | --- | --- | --- |
| L01 | Gmail first-time consent | Exact read-only scopes; callback connects correct mailbox | Google app + test account |
| L02 | Gmail consent denied | No account or imported mail created | Google test account |
| L03 | Outlook personal account | Consent, profile and mail read succeed | Microsoft app + personal account |
| L04 | Microsoft 365 organization | Required administrator consent handled clearly | Organization test tenant |
| L05 | Provider consent revoked | Visible connection error; previous tasks retained | Connected test mailbox |
| L06 | Refresh after access token expiry | Automatic refresh; no repeated consent | Live account + elapsed expiry |
| L07 | Google test-mode refresh expiry | Reconnect message, no silent success | Google app testing mode |
| L08 | Several Gmail and Outlook accounts | No cross-account task/thread merging | Multiple live mailboxes |
| L09 | Assessment email in Gmail Promotions | Source folder retained; obligation extracted | Live Gmail + synthetic mail |
| L10 | Important mail in Gmail Spam / Outlook Junk | Review suggestion with warning | Live test mailboxes |
| L11 | Unread and already-read mail | Both included in scan | Live test mailbox |
| L12 | Initial 30-day boundary | Newer mail read; older mail explicitly outside scope | Dated test mailbox |
| L13 | More than one provider page | Every page read without duplicates | Mailbox with 100+ matching messages |
| L14 | Mail arrives during scan | Next overlap scan captures it | Live mailbox |
| L15 | Message deleted/moved during scan | Failure surfaced or recovered on next scan | Live mailbox |
| L16 | Several obligations in one thread | Review required; user can create separate manual tasks | Live Gemini evaluation |
| L17 | Cancellation and completion | Existing task changed only after approval | Live model + follow-up mail |
| L18 | Subject changed / new conversation | Separate thread behavior understood; no false merge | Live Gmail/Outlook |
| L19 | Forwarded and quoted conversations | Responsibility and latest deadline identified | Live AI evaluation |
| L20 | Relative date without timezone | Review, no invented precise deadline | Live AI evaluation |
| L21 | DST fold/gap, leap day and locale formats | Uncertain interpretation reviewed | Live AI + device timezones |
| L22 | Contradictory deadlines or sender | Conflict surfaced for review | Live AI evaluation |
| L23 | Prompt injection / forged urgency | No unrelated action, secret disclosure or tool execution | Live AI evaluation |
| L24 | Phishing message in spam | Warning retained; no automated link/attachment execution | Controlled test mail |
| L25 | Attachment-only deadline | Known unsupported case; no claim of attachment coverage | Attachment samples |
| L26 | Actual 24h / 1h / overdue delivery | Correct device notification within scheduler tolerance | Server + live push service |
| L27 | Tab closed, server running | Supported browser still receives Web Push | Chrome/Edge/Firefox/Safari |
| L28 | Browser fully quit / OS background limits | Document actual platform delivery behavior | Each target device |
| L29 | Server stopped, then restarted | No mail checks while stopped; relevant catch-up reminder | Persistent host |
| L30 | Device offline then online | Delivery depends on push TTL; in-app reminder remains | Real device/network |
| L31 | Permission denied then changed | Clear setup path; subscription can be retried | Real browser |
| L32 | OS Focus / Do Not Disturb / silent mode | No promise of overriding operating-system controls | iOS/Android/desktop |
| L33 | iOS installed home-screen app | Verify installation and push prerequisites | Supported iPhone/iPad |
| L34 | Push subscription expires or rotates | Re-enable path works; expired subscription removed | Real browser + push service |
| L35 | Local timezone changes while using app | Display converts correctly; stored UTC deadline stable | Multiple device timezones |
| L36 | Phone/tablet/desktop layouts | No overflow; dialogs reachable; controls usable | 320px–1920px browser viewports |
| L37 | Keyboard and screen-reader use | Focus visibility, dialog behavior and readable labels | Browser + assistive technology |
| L38 | Browser storage disabled | Workspace loads; preference warning; server data retained | Real privacy modes |
| L39 | Note export from old file-based app | Import preserves note contents, IDs, categories, colors | Original SmartNotes export |
| L40 | Repeated import / interrupted import | Stable imported IDs; retry does not duplicate imported IDs | Browser + test export |
| L41 | Server network outage / quota exhaustion | Visible error and safe retry without duplicate tasks | Controlled provider quota/network |
| L42 | Storage full / write denied | Error surfaced; last persisted backup recoverable | Disposable filesystem |
| L43 | Process crash during save or delivery | Prior atomic snapshot readable; delivery may be retried | Disposable host |
| L44 | Two servers pointed at one data directory | Unsupported; do not run simultaneous writers | Deployment review |
| L45 | Backup restore and encryption-key loss | Restore matching key; otherwise reconnect accounts | Disposable backup |
| L46 | Very large mailbox or long AI thread | Visible limits; no false claim of full coverage | Synthetic load dataset |
| L47 | Gmail/Microsoft production verification | Provider policy and consent requirements met | Production app registration |
| L48 | Public hosting / multiple end users | Unsupported by this local MVP; requires authentication and per-user isolation first | Separate production implementation |

## Boundaries

DOM tests are not screenshot tests or real-browser compatibility tests. Mocked AI responses are not AI accuracy evaluations. Simulated push tests are not proof of audible alarms on phones. The original browser-only note app is retained unchanged and is not the target of this new dashboard suite. The first version still tracks one primary obligation per conversation, scans an initial 30-day window, ignores attachment content, and requires its local Node server to keep running.
