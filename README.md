# Bantay Ilog — River Watch

Community river-gauge monitoring for flood early warning. Volunteers photograph the river's staff gauge from
their phones. Claude reads the water level from the photo, the reading is checked against the observer's own,
the system tracks how fast the river is rising, and an alert agent warns residents on Telegram, in Tagalog and
English, before the river reaches the evacuation level.

![Architecture](docs/architecture.png)

## How a reading flows

1. **Capture** (`/capture`) — the phone camera shows a guide box; the photo is cropped to the gauge, checked for
   darkness, blur, glare and missing gauge colours (`lib/client/colorCheck.ts`), and sent with the observer's own
   reading. With no signal it is kept in IndexedDB and re-sent later (`lib/client/offlineQueue.ts`), and the page
   itself is cached by a service worker so it opens offline.
2. **Read** (`POST /api/frame`) — the photo is stored and Claude reads the level with vision + structured output
   (`lib/server/readGauge.ts`, prompt in `prompts/read-gauge.md`). A photo the model itself calls blurry, glary or
   choppy has its confidence capped below the solo-accept line, so a person looks at it.
3. **Agree** (`lib/server/agree.ts`) — accepted automatically only if AI and observer agree within the station
   tolerance (or the AI alone is very confident on a clean photo), the value is on the gauge, the photo is not one
   already sent, and the change since the last reading is physically plausible. Anything else goes to the observer
   team on Telegram with one-tap confirm/reject buttons, or to the dashboard. A reading can't be confirmed by the
   person who sent it — identity is compared, not spelling.
4. **Trend** (`lib/server/trend.ts`) — least-squares rate of rise over the last 2 hours and projected time to the
   next threshold.
5. **Alert** (`lib/server/alertAgent.ts`) — on a stage change, an elevated stage, a fast rise, or an all-clear, the
   system decides whether to message residents. Routine cases are decided by tested rules; the Claude tool-use agent
   (`lib/server/tools.ts`, prompt in `prompts/alert-agent.md`) is called for the judgement calls. Either way a
   deterministic **safety net** sends the stage alert itself if the river rose into a higher stage and nothing went out.
6. **Reminders** (`lib/server/tick.ts`) — at alert/alarm/critical stage the team is reminded to take readings
   every 60/30/15 minutes; the same pass checks the PAGASA rainfall advisory, retries undelivered messages and
   deletes photos past their retention.

Flood stages follow the 1st/2nd/3rd alarm convention: **alert** (be alert), **alarm** (prepare to evacuate),
**critical** (evacuate now). Thresholds are per station (`/setup`).

## What residents actually receive

The agent decides **whether and when** to warn people. It never writes the words: every message is rendered from a
reviewed bilingual template in `lib/server/messages.ts`, filled with the station's own numbers, evacuation center and
hotline. Five kinds:

| Kind | When |
|---|---|
| `stage` | the river reached a new flood stage |
| `early` | rising, and projected to cross the next threshold within ~2 hours |
| `provisional` | two sources disagree, and even the **lower** reading is above a stage residents haven't been warned about — a hedged "being checked" warning rather than silence while a volunteer is found |
| `de-escalation` | fell to a lower but still dangerous stage: don't go home yet |
| `all-clear` | normal again, confirmed by two readings and a margin below the threshold, so a river sitting on the line can't flip between "evacuate" and "all-clear" |

The same alert can't be repeated inside its window (15–120 min by stage), and the database refuses a duplicate on a
unique key, so two requests racing each other send one message rather than two.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

Everything works without any accounts. Each external service is optional and falls back to a local stand-in:

| Service | Configure | Without it |
|---|---|---|
| Claude (gauge reading + alert agent) | `ANTHROPIC_API_KEY` | **Mock mode**: only the demo station's synthetic photos are "read"; real photos are stored and sent for human confirmation. Alerts use the built-in rules. |
| Supabase (database + photo storage) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; run `supabase/schema.sql`; create the `gauge-photos` bucket | JSON file + photos under `DATA_DIR` (default `.data/`) |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, then `setWebhook` (see `/setup`) | Messages are printed to the server log and shown in the dashboard outbox |
| PAGASA advisory | `PAGASA_ADVISORY_URL` | Advisory step skipped; set one manually with `npm run job:pagasa -- --set orange "text"` |

Copy `.env.example` to `.env.local` to configure. The Claude model defaults to `claude-opus-5-5`
(`CLAUDE_MODEL` to change). Requests opt in to server-side refusal fallback (`fallbacks: "default"`).

Then open **`/demo`** and press *Run demo*: eight synthetic gauge photos of a rising river go through the real
pipeline, including one disagreement that a team leader confirms, and you can see every alert and message.

### Before it goes on the internet

- **`ADMIN_TOKEN`** — required in production. A production build refuses admin actions (editing stations, confirming
  readings, viewing photos and volunteer names) rather than running open. Development stays open so the demo needs no setup.
- **`TELEGRAM_WEBHOOK_SECRET`** — required once a bot token is set. Telegram signs each webhook call with it; without
  it, anyone who finds the URL can forge a confirmation and make residents get alerted.
- **`CRON_SECRET`** — enables `POST /api/cron`. Without it the endpoint returns 404 rather than letting anyone spend
  the station's model budget.
- Photo endpoints and volunteer names are admin-only; the public dashboard sees levels, stages and alerts.

### Keeping time

Reminders, the advisory check, message retries and photo retention all run in one pass. Either:

```bash
npm run job:pagasa -- --loop 5                      # a second process
curl -X POST https://…/api/cron -H "x-cron-secret: …"   # or any scheduler
```

`/api/health` returns 503 when that pass stops running or a station is at an elevated stage with no fresh reading,
so a monitor can watch it.

### Other commands

```bash
npm test                    # unit tests
npm run typecheck
npm run lint
npm run check               # all three
npm run build && npm start  # production server
npm run test:photos         # AI accuracy on your own labelled photos (see test-photos/README.md)
npm run samples             # regenerate demo gauge images and the alarm sound
```

### Docker

```bash
docker build -t bantay-ilog .
docker run -p 3000:3000 --env-file .env.local -v bantay-data:/data bantay-ilog
```

The image runs the web server only; point a scheduler at `/api/cron` for the periodic pass.

## Telegram commands

Residents: `/subscribe <station>`, `/stop`, `/status`. Deep link: `https://t.me/<bot>?start=<station>`.
Observer team (chat IDs listed on the station in `/setup`): receive confirmation requests with buttons and
reading reminders; can send `/reading <station> <metres>` (still needs a second person to confirm).

## Privacy

Gauge photos show a riverbank, often with houses and people in frame, and the names on readings are volunteers'.
So: photos and names are served only with the admin token, the public dashboard sees an initial, photos are deleted
after `PHOTO_RETENTION_DAYS` (default 30), and a resident's Telegram chat ID — the only thing stored about them — is
removed by `/stop`. Worth reviewing against the Data Privacy Act (RA 10173) before a real deployment.

## Upgrading an existing database

Run `supabase/migrations/001_hardening.sql` in the SQL editor.
