# Setup guide

A linear, start-to-finish walkthrough to deploy the whole stack for your own
alliance. Budget ~30–45 minutes the first time. Everything fits on free tiers
plus one small always-on host for the tracker.

> **All times in this stack are UTC** — database, UI, and logs. Keep that in
> mind when you create events.

Contents:

1. [Use this template & clone](#1-use-this-template--clone)
2. [Create a Supabase project](#2-create-a-supabase-project)
3. [Push the database schema](#3-push-the-database-schema)
4. [Create a Discord app & bot](#4-create-a-discord-app--bot)
5. [Frontend: run locally & deploy to Vercel](#5-frontend-run-locally--deploy-to-vercel)
6. [Tracker: run the bot & OCR service](#6-tracker-run-the-bot--ocr-service)
7. [First login & link yourself to an alliance](#7-first-login--link-yourself-to-an-alliance)

---

## 1. Use this template & clone

On the GitHub repo page, click **“Use this template” → “Create a new
repository”**. Then clone your copy:

```bash
git clone https://github.com/<you>/<your-repo>.git
cd <your-repo>
```

Layout you'll be working with:

```
frontend/   # React app (calendar + tracking dashboard)
tracker/    # Discord bot + OCR service
supabase/   # database migrations
docs/       # this guide
```

---

## 2. Create a Supabase project

1. Go to <https://supabase.com>, sign up, and **create a new project**. Pick a
   region close to your players and save the database password.
2. Once it's ready, open **Project Settings → API** and copy three values —
   you'll need them below:
   - **Project URL** → used as `VITE_SUPABASE_URL` (frontend) and `SUPABASE_URL`
     (tracker).
   - **`anon` `public` key** → `VITE_SUPABASE_ANON_KEY` (frontend).
   - **`service_role` key** → `SUPABASE_SERVICE_ROLE_KEY` (tracker only —
     **never** put this in the frontend or commit it).

---

## 3. Push the database schema

All migrations live in `supabase/migrations/`. They create the frontend's
`events` table (`0000_events.sql`) and the tracker's `at_*` tables/views/policies
(`0001`–`0017`), in order.

### Option A — Supabase CLI (recommended)

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from the
repo root:

```bash
supabase link --project-ref <your-project-ref>   # ref is in your project URL
supabase db push
```

This applies every file in `supabase/migrations/` in filename order against a
fresh project, creating all tables with no errors.

### Option B — paste the SQL

If you'd rather not install the CLI: open the Supabase **SQL Editor** and run the
contents of each file in `supabase/migrations/` **in numeric order**, starting
with `0000_events.sql`. Order matters — later migrations reference earlier
tables.

### Verify

In the SQL Editor:

```sql
select table_name from information_schema.tables
where table_schema = 'public'
order by table_name;
```

You should see `events` plus the `at_*` tables (`at_alliances`, `at_players`,
`at_events`, `at_participations`, `at_donations`, `at_player_stats`,
`at_alliance_members`, …).

> `0008_at_seed_alliances.sql` ships empty on purpose. You'll add your
> alliance row in [step 7](#7-first-login--link-yourself-to-an-alliance).

---

## 4. Create a Discord app & bot

The tracker needs a Discord bot to read screenshots posted in your alliance
channels.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application**.
2. **Bot** tab → **Add Bot** → **Reset Token** → copy the token. This is your
   `DISCORD_BOT_TOKEN`.
3. Still on the **Bot** tab, scroll to **Privileged Gateway Intents** and enable
   **Message Content Intent** (required to read screenshot attachments).
4. **OAuth2 → URL Generator**: tick the `bot` and `applications.commands`
   scopes, then under bot permissions tick at least **Read Messages/View
   Channels**, **Send Messages**, **Read Message History**, and **Attach
   Files**. Open the generated URL to **invite the bot** to your server.
5. Get your channel IDs: in Discord, enable **Settings → Advanced → Developer
   Mode**, then right-click each alliance channel → **Copy Channel ID**. The
   comma-separated list is your `DISCORD_ALLOWED_CHANNEL_IDS`.

Keep the bot token and channel IDs handy for step 6.

---

## 5. Frontend: run locally & deploy to Vercel

### Local

```bash
cd frontend
cp .env.example .env
# edit .env:
#   VITE_SUPABASE_URL=...        (Project URL from step 2)
#   VITE_SUPABASE_ANON_KEY=...   (anon public key from step 2)
npm install
npm run dev          # open the printed localhost URL
```

You should see the event calendar. Add an event to confirm the Supabase
connection works (it writes to the `events` table). `npm run build` and
`npm test` should both pass.

### Deploy to Vercel

1. Push your repo to GitHub (if you haven't already).
2. At <https://vercel.com> → **Add New… → Project** → import your repo.
3. Set the **Root Directory** to `frontend`. Vercel auto-detects Vite (build
   `npm run build`, output `dist`). A `vercel.json` is included so client-side
   routes like `/tracking` resolve correctly.
4. Add **Environment Variables** `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` (same values as your local `.env`).
5. **Deploy.** Every push to your default branch redeploys automatically.

---

## 6. Tracker: run the bot & OCR service

The tracker is two services orchestrated by `tracker/docker-compose.yml`. It
needs an always-on host with Docker (a small VPS, a home server, or a
PaaS — see the note at the end).

```bash
cd tracker
cp apps/discord-bot/.env.example  apps/discord-bot/.env
cp apps/ocr-service/.env.example  apps/ocr-service/.env
```

Fill in `apps/discord-bot/.env`:

```
DISCORD_BOT_TOKEN=...                 # from step 4
DISCORD_ALLOWED_CHANNEL_IDS=...       # comma-separated channel IDs from step 4
SUPABASE_URL=...                      # Project URL from step 2
SUPABASE_SERVICE_ROLE_KEY=...         # service_role key from step 2 (server-side only!)
```

Fill in `apps/ocr-service/.env` — for a basic deterministic setup you only need:

```
SUPABASE_URL=...                      # same Project URL (optional -- see table below)
SUPABASE_SERVICE_ROLE_KEY=...         # service_role key (optional; not the anon key -- see table below)
LLM_FALLBACK_ENABLED=false            # set true + configure OLLAMA_* to enable the LLM fallback
```

Then build and start:

```bash
docker compose up --build -d
docker compose logs -f discord-bot     # watch it connect & register slash commands
```

Post a game screenshot in one of your configured channels (or use
`/upload kind:<event|donation|player_stats>` if auto-detection is unsure). The
bot deduplicates, runs OCR, and UPSERTs rows into the `at_*` tables.

> **Hosting on a PaaS instead?** Railway and Fly.io both deploy straight from
> this repo. Point them at `tracker/` and the two Dockerfiles
> (`apps/discord-bot/Dockerfile`, `apps/ocr-service/Dockerfile`), set the same
> env vars as above through the platform's secrets UI, and let the bot reach the
> OCR service over the internal network (`OCR_SERVICE_URL`). No public ingress
> is required — the bot talks to Discord outbound and to Supabase over HTTPS.

### Environment variables reference

Full list of variables read by each service. "Default" is what the code falls
back to when the variable is unset — not always the same as the value shipped
in `.env.example`, which sometimes ships a tuned recommendation instead (noted
below).

**`apps/discord-bot`**

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | *(required)* | Bot token from step 4. |
| `DISCORD_ALLOWED_CHANNEL_IDS` | *(required)* | Comma-separated channel IDs the bot ingests from. |
| `SUPABASE_URL` | *(required)* | Same Supabase project as the frontend. |
| `SUPABASE_SERVICE_ROLE_KEY` | *(required)* | Bypasses RLS to write `at_*` tables. Never expose client-side. |
| `OCR_SERVICE_URL` | `http://ocr-service:8000` | Where the bot reaches the OCR service. |
| `OCR_TIMEOUT_MS` | `1800000` (30 min) | Total polling budget for one OCR job. |
| `OCR_POLL_INTERVAL_MS` | `5000` | Delay between two `GET /jobs/<id>` polls. |
| `DATA_INBOX_DIR` | `/data/inbox` | Where incoming screenshots are staged (sha256 dedup). |
| `REPROCESS_CONCURRENCY` | `3` | Screenshots processed in parallel by `/reprocess-channel` and `/reprocess`. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

**`apps/ocr-service`**

| Variable | Default | Purpose |
|---|---|---|
| `SUPABASE_URL` | *(optional)* | Set with `SUPABASE_SERVICE_ROLE_KEY` to load title aliases from the DB; leave both empty to silently use the embedded static alias list. There is no `SUPABASE_ANON_KEY` here — the anon key is never read by this service. |
| `SUPABASE_SERVICE_ROLE_KEY` | *(optional)* | See above. RLS on `at_event_types` only allows the `authenticated` role, so the anon key would not work anyway. |
| `JOBS_DB_PATH` | `/data/jobs.db` | SQLite path for the job store. |
| `LOG_LEVEL` | `INFO` | Python `logging` level name. |
| `LLM_FALLBACK_ENABLED` | `false` | Set `true` (+ configure `OLLAMA_*`) to re-OCR low-confidence names via a vision LLM. |
| `LLM_MAX_CONSECUTIVE_FAILURES` | `2` | Stop calling the LLM after this many *consecutive* failures within one image. |
| `OCR_BACKEND` | `tesserocr` | `tesserocr` (in-process) or `pytesseract` (subprocess rollback). |
| `OCR_TESS_POOL_SIZE` | `16` | Size of the `tesserocr` `PyTessBaseAPI` instance pool. |
| `OCR_CONFIDENCE_THRESHOLD` | `0.75` | Global fallback threshold used when a field-specific one below is unset. |
| `OCR_CONFIDENCE_THRESHOLD_NAME` | `0.75` | Recommended: `0.35` — names score structurally lower than other fields on some game fonts. |
| `OCR_CONFIDENCE_THRESHOLD_RANK` | `0.75` | Recommended: `0.85` — near-certain with a whitelisted charset. |
| `OCR_CONFIDENCE_THRESHOLD_POWER` | `0.75` | Recommended: `0.85`. |
| `OCR_CONFIDENCE_THRESHOLD_POINTS` | `0.75` | Recommended: `0.85`. |
| `OCR_NAME_ASCII_FAST_PATH_ENABLED` | `true` | Try a fast ASCII-only OCR pass before the full multilingual one. |
| `OCR_NAME_ASCII_FAST_PATH_MIN_CONF` | `0.60` | Confidence floor to accept the fast-path result. |
| `OCR_FUZZY_TITLE_THRESHOLD` | `0.82` | Similarity floor for matching a screenshot's title to a known event type. |
| `OCR_TAB_DETECT_MIN_DELTA` | `4.0` | Contribution-ranking parser: minimum pixel delta to detect a tab boundary. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Only used when `LLM_FALLBACK_ENABLED=true`. |
| `OLLAMA_API_KEY` | *(empty)* | Leave empty for a loopback Ollama with no auth. |
| `OLLAMA_MODEL` | `moondream` | Vision model name. |
| `OLLAMA_NUM_CTX` | `2048` | Context window size. |
| `OLLAMA_NUM_PREDICT` | `256` | Max generated tokens per request. |
| `OLLAMA_THINK` | `false` | Only affects "thinking" models; ignored by e.g. moondream. |
| `OLLAMA_KEEP_ALIVE` | `30m` | How long Ollama keeps the model loaded after a request. |
| `OLLAMA_TIMEOUT_SECONDS` | `300` | HTTP timeout per `/api/generate` call. |
| `OLLAMA_PLAYER_STATS_TIMEOUT_SECONDS` | `90` | Separate timeout for the one-shot full-image player-stats path. |
| `OLLAMA_PLAYER_STATS_MAX_WIDTH` | `720` | Max width (px) of the image sent to the LLM for player stats. |
| `OLLAMA_PLAYER_STATS_MAX_HEIGHT` | `960` | Max height (px), same reasoning. |

---

## 7. First login & link yourself to an alliance

The `/tracking` dashboard requires a logged-in user, and RLS only shows a user
the alliances they belong to. So you need (a) a Supabase Auth account and (b) a
row linking that account to an alliance.

1. **Create your alliance row.** In the Supabase **SQL Editor**:

   ```sql
   insert into at_alliances (name, discord_channel_id)
   values ('My Alliance', '000000000000000000')   -- use a real channel ID from step 4
   on conflict (name) do update
     set discord_channel_id = excluded.discord_channel_id;
   ```

   (The bot also needs this row to map incoming screenshots — the
   `discord_channel_id` must match one of your `DISCORD_ALLOWED_CHANNEL_IDS`.)

2. **Create a user account.** In Supabase, go to **Authentication → Users → Add
   user** (set an email + password), or sign up through the login screen at
   `/tracking` on your deployed site. Email/password auth is enabled by default.

3. **Find the IDs you need:**

   ```sql
   select id, email from auth.users;          -- copy your user_id
   select id, name  from at_alliances;        -- copy your alliance_id
   ```

4. **Link yourself to the alliance** (this is what RLS checks):

   ```sql
   insert into at_alliance_members (alliance_id, user_id, role)
   values ('<alliance_id>', '<user_id>', 'admin');
   ```

5. Open `/tracking` on your site, log in, and you should now see your alliance,
   its events, players, donations, and stats as the bot ingests screenshots.

---

That's the full loop. From here: invite teammates by repeating step 7's
account + `at_alliance_members` row for each, keep posting screenshots to feed
the dashboard, and add calendar events in the main app. Everything stays in UTC.
