# Alliance Tracker integration — `/tracking` dashboard

> Guide for integrating the `at_*` tables (produced by the tracker) into the React frontend's `/tracking` dashboard.

---

## Context

The backend (Discord bot + OCR service) lives in a separate `alliance-tracker` repo, deployed on the home server. Data flows through the **shared** Supabase project with the frontend (`frontend/`), in tables prefixed `at_*`.

The dashboard is added to the frontend (`frontend/`) as a new feature, not a replacement. The goal is to reuse as much of what already exists as possible (auth, layout, Supabase client, theme, components) and to keep the new code isolated under `src/features/tracking/`.

---

## What's already in place in the frontend (`frontend/`)

To check and confirm before starting:

- **Stack**: Vite + React + React Router
- **Supabase client**: shared instance, probably in `src/lib/supabase.ts` or equivalent
- **Auth**: Supabase Auth, session managed (React context or custom hook)
- **Env vars**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` already configured on Vercel
- **Routing**: a top-level `<BrowserRouter>` with `<Routes>`
- **Layout**: a header/nav component listing the main tabs or sections

If any of these points is missing or differs, ask the user before improvising.

---

## Integration steps

### 1. Supabase migration (if not already done from `alliance-tracker`)

The `at_*` tables must exist in the Supabase project. They're normally created by the migrations in the `alliance-tracker` repo (§3 of its `PLAN.md`).

Quick check:

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name like 'at_%'
order by table_name;
```

Must return at least: `at_alliance_members`, `at_alliance_memberships`, `at_alliances`, `at_event_types`, `at_events`, `at_participations`, `at_players`, `at_screenshot_uploads`.

If missing, apply the migrations from `alliance-tracker/supabase/migrations/`.

### 2. Declare the Supabase types

If the frontend (`frontend/`) uses `supabase gen types typescript`, regenerate it to include the `at_*` tables:

```bash
npx supabase gen types typescript --project-id <id> > src/types/database.types.ts
```

Otherwise, manually create `src/features/tracking/types.ts` with the necessary types (or import from the `shared-types` package of the `alliance-tracker` repo, if published).

### 3. Add the navigation entry

In the main navigation component (probably `src/components/Nav.tsx` or `src/layouts/MainLayout.tsx`), add a link to `/tracking`:

```tsx
// Example — adapt to the actual structure
<NavLink to="/tracking">Alliance Tracking</NavLink>
```

The link should only appear for authenticated users who have at least one row in `at_alliance_members`. Use a hook like `useUserAlliances()` that returns the logged-in user's alliances (see step 5).

### 4. Add the routes

In the routing config (probably `src/App.tsx` or `src/routes.tsx`), register the new routes under `/tracking`:

```tsx
import { TrackingLayout } from './features/tracking/TrackingLayout';
import { TrackingHome } from './features/tracking/pages/Home';
import { EventsPage } from './features/tracking/pages/Events';
import { EventDetailPage } from './features/tracking/pages/EventDetail';
import { PlayersPage } from './features/tracking/pages/Players';
import { PlayerDetailPage } from './features/tracking/pages/PlayerDetail';
import { RequireAuth } from './components/RequireAuth'; // adapt as needed

// Inside Routes:
<Route path="/tracking" element={<RequireAuth><TrackingLayout /></RequireAuth>}>
  <Route index element={<TrackingHome />} />
  <Route path="alliances/:allianceId">
    <Route path="events" element={<EventsPage />} />
    <Route path="events/:eventId" element={<EventDetailPage />} />
    <Route path="players" element={<PlayersPage />} />
    <Route path="players/:playerId" element={<PlayerDetailPage />} />
  </Route>
</Route>
```

### 5. Feature structure

All of the feature's code lives under `src/features/tracking/` for maximum isolation:

```
src/features/tracking/
├── TrackingLayout.tsx        # wrapper with alliance-selection sidebar
├── pages/
│   ├── Home.tsx              # selector + overview
│   ├── Events.tsx
│   ├── EventDetail.tsx
│   ├── Players.tsx
│   └── PlayerDetail.tsx
├── components/
│   ├── AllianceSwitcher.tsx
│   ├── EventCard.tsx
│   ├── LeaderboardTable.tsx
│   ├── ParticipationRateTable.tsx
│   ├── PowerHistoryChart.tsx
│   └── PointsEvolutionChart.tsx
├── hooks/
│   ├── useUserAlliances.ts
│   ├── useAllianceEvents.ts
│   ├── useEventLeaderboard.ts
│   ├── usePlayerStats.ts
│   └── useParticipationRates.ts
├── queries/
│   └── atQueries.ts          # all Supabase queries centralized
└── types.ts
```

Nothing in this feature writes to the `at_*` tables — read-only. Writes are done by the Discord bot in the `alliance-tracker` repo using `service_role_key`. The dashboard only uses `anon_key` + user session, with RLS active.

### 6. Query examples

**`useUserAlliances` hook** (for the alliance selector and the navigation guard):

```tsx
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export function useUserAlliances() {
  return useQuery({
    queryKey: ['at', 'my-alliances'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('at_alliance_members')
        .select('alliance_id, role, at_alliances(id, name)')
        .order('alliance_id');
      if (error) throw error;
      return data.map(row => ({
        id: row.at_alliances.id,
        name: row.at_alliances.name,
        role: row.role,
      }));
    },
  });
}
```

**`useAllianceEvents` hook** (paginated list of events):

```tsx
export function useAllianceEvents(allianceId: string, limit = 20) {
  return useQuery({
    queryKey: ['at', 'events', allianceId, limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('at_events')
        .select('id, event_datetime, alliance_rank, total_battlers, total_points, at_event_types(code, display_name)')
        .eq('alliance_id', allianceId)
        .order('event_datetime', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    },
    enabled: !!allianceId,
  });
}
```

**`useEventLeaderboard` hook** (an event's leaderboard, via the view):

```tsx
export function useEventLeaderboard(eventId: string) {
  return useQuery({
    queryKey: ['at', 'leaderboard', eventId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('at_v_event_leaderboard')
        .select('*')
        .eq('event_id', eventId)
        .order('position');
      if (error) throw error;
      return data;
    },
    enabled: !!eventId,
  });
}
```

**`useParticipationRates` hook** (per-player rate view):

```tsx
export function useParticipationRates(allianceId: string) {
  return useQuery({
    queryKey: ['at', 'participation-rates', allianceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('at_v_player_participation_rate')
        .select('*')
        .eq('alliance_id', allianceId)
        .order('participation_rate_pct', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data;
    },
    enabled: !!allianceId,
  });
}
```

### 7. UI — guidance

The dashboard must stay visually consistent with the rest of the frontend (`frontend/`). Use:

- The same theme / CSS variables / Tailwind config
- The same base components (buttons, cards, tables) if available
- The same loading / error patterns (spinners, toasts)

Feature-specific components to create:

- `AllianceSwitcher`: dropdown or sidebar listing the user's alliances
- `EventCard`: card summarizing an event (type, date, rank, total battlers)
- `LeaderboardTable`: leaderboard table with columns `position, player_name, rank, power, points`
- `ParticipationRateTable`: sortable table with `name, rate%, events_participated/eligible_events, avg_points, last_participation`
- `PointsEvolutionChart`: `points` curve on Y, `event_datetime` on X, for a given player (Recharts or equivalent already used in the project)
- `PowerHistoryChart`: same for `power`

### 8. Permission handling

Visibility is handled by RLS on the Supabase side. The dashboard has nothing special to do beyond:

- Showing the "Alliance Tracking" nav link only if `useUserAlliances()` returns at least 1 alliance
- Redirecting to `/` if a user tries to access `/tracking/alliances/:id/...` for an alliance they're not part of (RLS will return 0 rows; show a "Not authorized" message)
- Not exposing any write UI (no forms that modify `at_*`). Every change goes through the bot's Discord commands.

### 9. Adding a user to an alliance

This operation has NO UI for now. To add a user to an alliance:

```sql
insert into at_alliance_members (alliance_id, user_id, role)
values ('<alliance_id>', '<user_id>', 'viewer');
```

To be done manually from the Supabase console, or via an admin Discord command (Phase 4+). If this need becomes frequent, plan for an admin page `/tracking/admin` visible only for `role = 'admin'`.

---

## Deployment checklist

- [ ] `at_*` migrations applied on the Supabase project
- [ ] TypeScript types regenerated or added manually
- [ ] `/tracking` route added to the routing
- [ ] Conditional navigation link (visible if `useUserAlliances()` is non-empty)
- [ ] `src/features/tracking/` feature created and isolated
- [ ] Supabase hooks with React Query (or equivalent used in the project)
- [ ] Vitest tests on at least the main hooks
- [ ] PR to main → Vercel preview
- [ ] Manual validation on preview with a test user
- [ ] Merge → automatic production deployment

**Military stats (`player_stats` feature)**

- [ ] Migrations `0015_at_player_stats.sql` and `0016_at_player_stats_views.sql` applied
- [ ] Route `/tracking/alliances/:id/stats` added under the existing alliance route
- [ ] `PlayerStatsTable` created and wired to `usePlayerStatsLatest`
- [ ] `usePlayerStatsHistory` implemented for the player profile (evolution chart)

---

## Player military stats

The `player_stats_chat` feature adds a 3rd screenshot type to the pipeline: screenshots of the in-game "(LOL) City stats" chat, where members post their stats.

### Available tables and views

- **`at_player_stats`** — one row per player per day, latest-wins via UPSERT. Columns: `player_id, alliance_id, attack_pct, attack_kind (lra|mra), hp_pct, defense_pct, ocr_confidence, recorded_date`.
- **`at_v_player_stats_latest`** — latest stats per player (1 row per player). Extra columns: `player_name, last_rank, alliance_name`.
- **`at_v_player_stats_history`** — full history, to be filtered by `alliance_id` and `player_id`, sorted by `recorded_date`.

### New route

```tsx
// Under the /tracking/alliances/:allianceId/ route
<Route path="stats" element={<PlayerStatsPage />} />
```

Add a "Stats" tab in the alliance's sub-nav, next to "Events", "Players" and "Donations".

### `usePlayerStatsLatest` hook

```ts
// src/features/tracking/hooks/usePlayerStatsLatest.ts
export function usePlayerStatsLatest(allianceId: string) {
  return useQuery({
    queryKey: ['at', 'player-stats-latest', allianceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('at_v_player_stats_latest')
        .select('*')
        .eq('alliance_id', allianceId)
        .order('attack_pct', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data;
    },
    enabled: !!allianceId,
  });
}
```

### `usePlayerStatsHistory` hook

```ts
// src/features/tracking/hooks/usePlayerStatsHistory.ts
export function usePlayerStatsHistory(allianceId: string, playerId: string) {
  return useQuery({
    queryKey: ['at', 'player-stats-history', allianceId, playerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('at_v_player_stats_history')
        .select('*')
        .eq('alliance_id', allianceId)
        .eq('player_id', playerId)
        .order('recorded_date', { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: !!allianceId && !!playerId,
  });
}
```

### `PlayerStatsPage` page

Components to create in `src/features/tracking/components/`:

- **`PlayerStatsTable`** — table sorted by `attack_pct` desc, columns: Player, Rank, Attack %, HP %, Defense %, Date. Each row is clickable and navigates to `/players/:playerId` (player profile).
- **`StatsEvolutionChart`** — line chart showing the evolution of `attack_pct` / `hp_pct` / `defense_pct` over `recorded_date`. Reuse the `PointsEvolutionChart` pattern (Recharts or equivalent).

Stats are shown in the existing player profile (`PlayerDetailPage`) by adding a "Military stats" section that consumes `usePlayerStatsHistory`.

---

## What NOT to do in the frontend (`frontend/`)

- Write to the `at_*` tables from the frontend (read-only)
- Use `service_role_key` — only `anon_key`
- Duplicate the Supabase client — use the one that already exists
- Create tables or migrations prefixed other than `at_` for this feature
- Mix tracking code with other features — everything must stay under `src/features/tracking/`
- Change the global theme or layout for this specific feature
- Assume a user has access to every alliance — always filter by `useUserAlliances()`

---

## FAQ

**Why not a separate Vercel project?**
To avoid multiplying projects. Auth, the Supabase client, the theme and the deployment are already in place in the frontend (`frontend/`).

**Why not a separate Supabase project?**
Same reason: avoid multiplying accounts and have a single database to back up. The `at_` prefix is enough to isolate.

**Why Vite and not Next.js?**
Consistency with what already exists. The frontend (`frontend/`) project is on Vite; we don't switch stacks for a sub-feature.

**How do I test locally with real data?**
Get a dump of the Supabase database (or use `supabase start` with the migrations), then manually populate a test alliance with a few screenshots processed by the bot running in dev mode.

**Does the Discord bot need to run locally for dashboard dev?**
No. The dashboard just reads the database. To develop the dashboard, you just need data in the `at_*` tables (whether it comes from the prod bot or a manual seed).

**How do I add a new event type?**
Backend side: add a parser in `alliance-tracker/apps/ocr-service/app/parsers/`, add a row in `at_event_types`. Dashboard side: normally nothing to change if the new type uses the same fields (points, power, rank). Otherwise, add specific rendering in `EventDetailPage` conditioned on `event_type.code`.
