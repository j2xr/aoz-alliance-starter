# Intégration Alliance Tracker — dashboard `/tracking`

> Guide d'intégration des tables `at_*` (produites par le tracker) dans le dashboard `/tracking` du frontend React.

---

## Contexte

Le backend (bot Discord + service OCR) vit dans un repo séparé `alliance-tracker`, déployé sur le home server. Les données transitent dans le projet Supabase **partagé** avec the frontend (`frontend/`), dans des tables préfixées `at_*`.

Le dashboard s'ajoute à the frontend (`frontend/`) comme une nouvelle feature, pas un remplacement. L'objectif est de réutiliser au maximum ce qui existe (auth, layout, client Supabase, thème, composants) et de cloisonner le nouveau code sous `src/features/tracking/`.

---

## Ce qui est déjà en place dans the frontend (`frontend/`)

À vérifier et confirmer avant de commencer :

- **Stack** : Vite + React + React Router
- **Supabase client** : instance partagée, probablement dans `src/lib/supabase.ts` ou équivalent
- **Auth** : Supabase Auth, session gérée (contexte React ou hook custom)
- **Variables d'env** : `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` déjà configurées sur Vercel
- **Routing** : un `<BrowserRouter>` avec des `<Routes>` en top-level
- **Layout** : un composant header/nav qui liste les onglets ou sections principales

Si un de ces points manque ou diffère, demander à l'utilisateur avant d'improviser.

---

## Étapes d'intégration

### 1. Migration Supabase (si pas déjà faite depuis `alliance-tracker`)

Les tables `at_*` doivent exister dans le projet Supabase. Normalement elles sont créées par les migrations du repo `alliance-tracker` (§3 de son `PLAN.md`).

Vérification rapide :

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name like 'at_%'
order by table_name;
```

Doit retourner au minimum : `at_alliance_members`, `at_alliance_memberships`, `at_alliances`, `at_event_types`, `at_events`, `at_participations`, `at_players`, `at_screenshot_uploads`.

Si absent, appliquer les migrations depuis `alliance-tracker/supabase/migrations/`.

### 2. Déclarer les types Supabase

Si the frontend (`frontend/`) utilise `supabase gen types typescript`, régénérer pour inclure les tables `at_*` :

```bash
npx supabase gen types typescript --project-id <id> > src/types/database.types.ts
```

Sinon, créer manuellement `src/features/tracking/types.ts` avec les types nécessaires (ou importer depuis le package `shared-types` du repo `alliance-tracker` si publié).

### 3. Ajouter l'entrée de navigation

Dans le composant de navigation principal (probablement `src/components/Nav.tsx` ou `src/layouts/MainLayout.tsx`), ajouter un lien vers `/tracking` :

```tsx
// Exemple — à adapter à la structure réelle
<NavLink to="/tracking">Alliance Tracking</NavLink>
```

Le lien ne doit apparaître que pour les utilisateurs authentifiés et ayant au moins une ligne dans `at_alliance_members`. Utiliser un hook de type `useUserAlliances()` qui retourne les alliances du user connecté (cf étape 5).

### 4. Ajouter les routes

Dans la config de routing (probablement `src/App.tsx` ou `src/routes.tsx`), enregistrer les nouvelles routes sous `/tracking` :

```tsx
import { TrackingLayout } from './features/tracking/TrackingLayout';
import { TrackingHome } from './features/tracking/pages/Home';
import { EventsPage } from './features/tracking/pages/Events';
import { EventDetailPage } from './features/tracking/pages/EventDetail';
import { PlayersPage } from './features/tracking/pages/Players';
import { PlayerDetailPage } from './features/tracking/pages/PlayerDetail';
import { RequireAuth } from './components/RequireAuth'; // à adapter

// Dans les Routes :
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

### 5. Structure de la feature

Tout le code de la feature vit dans `src/features/tracking/` pour isolation maximale :

```
src/features/tracking/
├── TrackingLayout.tsx        # wrapper avec sidebar de sélection d'alliance
├── pages/
│   ├── Home.tsx              # sélecteur + vue d'ensemble
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
│   └── atQueries.ts          # toutes les requêtes Supabase centralisées
└── types.ts
```

Rien de cette feature n'écrit vers les tables `at_*` — lecture uniquement. Les écritures sont faites par le bot Discord du repo `alliance-tracker` avec `service_role_key`. Le dashboard utilise uniquement `anon_key` + session utilisateur, avec RLS active.

### 6. Exemples de requêtes

**Hook `useUserAlliances`** (pour le sélecteur d'alliance et la garde de navigation) :

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

**Hook `useAllianceEvents`** (liste paginée d'événements) :

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

**Hook `useEventLeaderboard`** (classement d'un événement via la vue) :

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

**Hook `useParticipationRates`** (vue des taux par joueur) :

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

### 7. UI — indications

Le dashboard doit rester cohérent visuellement avec le reste de the frontend (`frontend/`). Utiliser :

- Le même thème / variables CSS / Tailwind config
- Les mêmes composants de base (boutons, cards, tables) si disponibles
- Les mêmes patterns de chargement / erreur (spinners, toasts)

Composants spécifiques à créer pour cette feature :

- `AllianceSwitcher` : dropdown ou sidebar listant les alliances du user
- `EventCard` : carte résumant un événement (type, date, rank, total battlers)
- `LeaderboardTable` : tableau classement avec colonnes `position, player_name, rank, power, points`
- `ParticipationRateTable` : tableau triable avec `name, rate%, events_participated/eligible_events, avg_points, last_participation`
- `PointsEvolutionChart` : courbe `points` en Y, `event_datetime` en X, pour un joueur donné (Recharts ou équivalent déjà utilisé dans le projet)
- `PowerHistoryChart` : idem pour `power`

### 8. Gestion des permissions

La visibilité est gérée par RLS côté Supabase. Le dashboard n'a rien à faire de spécial au-delà de :

- Afficher le lien "Alliance Tracking" dans la nav uniquement si `useUserAlliances()` retourne au moins 1 alliance
- Rediriger vers `/` si un user tente d'accéder à `/tracking/alliances/:id/...` pour une alliance dont il ne fait pas partie (RLS retournera 0 lignes, afficher un message "Non autorisé")
- Ne pas exposer d'UI d'écriture (pas de formulaires qui modifient `at_*`). Toute modification passe par les commandes Discord du bot.

### 9. Ajouter un utilisateur à une alliance

Cette opération n'a PAS d'UI pour l'instant. Pour ajouter un utilisateur à une alliance :

```sql
insert into at_alliance_members (alliance_id, user_id, role)
values ('<alliance_id>', '<user_id>', 'viewer');
```

À faire manuellement depuis la console Supabase, ou via une commande Discord admin (Phase 4+). Si ce besoin devient fréquent, prévoir une page admin `/tracking/admin` visible uniquement pour `role = 'admin'`.

---

## Checklist de déploiement

- [ ] Migrations `at_*` appliquées sur le projet Supabase
- [ ] Types TypeScript régénérés ou ajoutés manuellement
- [ ] Route `/tracking` ajoutée dans le routing
- [ ] Lien de navigation conditionnel (visible si `useUserAlliances()` non vide)
- [ ] Feature `src/features/tracking/` créée et isolée
- [ ] Hooks Supabase avec React Query (ou équivalent utilisé dans le projet)
- [ ] Tests Vitest sur au moins les hooks principaux
- [ ] PR vers main → preview Vercel
- [ ] Validation manuelle sur preview avec un user test
- [ ] Merge → déploiement production auto

**Stats militaires (feature `player_stats`)**

- [ ] Migrations `0015_at_player_stats.sql` et `0016_at_player_stats_views.sql` appliquées
- [ ] Route `/tracking/alliances/:id/stats` ajoutée sous la route alliance existante
- [ ] `PlayerStatsTable` créé et lié à `usePlayerStatsLatest`
- [ ] `usePlayerStatsHistory` implémenté pour la fiche joueur (graphique d'évolution)

---

## Stats militaires des joueurs

La feature `player_stats_chat` ajoute un 3ème type de capture au pipeline : des screenshots du chat in-game "(LOL) City stats" où les membres postent leurs stats.

### Tables et vues disponibles

- **`at_player_stats`** — une ligne par joueur par jour, latest-wins via UPSERT. Colonnes : `player_id, alliance_id, attack_pct, attack_kind (lra|mra), hp_pct, defense_pct, ocr_confidence, recorded_date`.
- **`at_v_player_stats_latest`** — dernières stats par joueur (1 ligne par joueur). Colonnes supplémentaires : `player_name, last_rank, alliance_name`.
- **`at_v_player_stats_history`** — historique complet, à filtrer par `alliance_id` et `player_id`, trié par `recorded_date`.

### Nouvelle route

```tsx
// Sous la route /tracking/alliances/:allianceId/
<Route path="stats" element={<PlayerStatsPage />} />
```

Ajouter un onglet "Stats militaires" dans la sous-nav de l'alliance, à côté de "Événements", "Joueurs" et "Dons".

### Hook `usePlayerStatsLatest`

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

### Hook `usePlayerStatsHistory`

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

### Page `PlayerStatsPage`

Composants à créer dans `src/features/tracking/components/` :

- **`PlayerStatsTable`** — tableau trié par `attack_pct` desc, colonnes : Joueur, Rang, Attaque %, HP %, Défense %, Date. Chaque ligne est cliquable et navigue vers `/players/:playerId` (fiche joueur).
- **`StatsEvolutionChart`** — graphique en courbes montrant l'évolution de `attack_pct` / `hp_pct` / `defense_pct` sur `recorded_date`. Réutiliser le pattern de `PointsEvolutionChart` (Recharts ou équivalent).

Les stats sont affichées dans la fiche joueur existante (`PlayerDetailPage`) en ajoutant une section "Stats militaires" qui consomme `usePlayerStatsHistory`.

---

## À ne pas faire dans the frontend (`frontend/`)

- Écrire dans les tables `at_*` depuis le frontend (lecture uniquement)
- Utiliser `service_role_key` — uniquement `anon_key`
- Dupliquer le client Supabase — utiliser celui qui existe déjà
- Créer des tables ou migrations préfixées autrement que `at_` pour cette feature
- Mélanger le code de tracking avec les autres features — tout doit rester sous `src/features/tracking/`
- Changer le thème ou le layout global pour cette feature spécifique
- Assumer qu'un user a accès à toutes les alliances — toujours filtrer par `useUserAlliances()`

---

## Questions fréquentes

**Pourquoi pas un projet Vercel séparé ?**
Éviter la multiplication des projets. L'auth, le client Supabase, le thème et le déploiement sont déjà en place dans the frontend (`frontend/`).

**Pourquoi pas un projet Supabase séparé ?**
Même raison : éviter la multiplication des comptes et avoir une seule base à sauvegarder. Le préfixe `at_` suffit pour isoler.

**Pourquoi Vite et pas Next.js ?**
Cohérence avec l'existant. Le projet the frontend (`frontend/`) est en Vite, on ne change pas de stack pour une sous-feature.

**Comment tester en local avec des données réelles ?**
Récupérer un dump de la base Supabase (ou utiliser `supabase start` avec les migrations), puis peupler manuellement une alliance de test avec quelques captures traitées par le bot déployé en mode dev.

**Le bot Discord tourne-t-il en local pour le dev du dashboard ?**
Non. Le dashboard se contente de lire la base. Pour développer le dashboard, il suffit d'avoir des données dans les tables `at_*` (qu'elles viennent du bot de prod ou d'un seed manuel).

**Comment ajouter un nouveau type d'événement ?**
Côté backend : ajouter un parseur dans `alliance-tracker/apps/ocr-service/app/parsers/`, ajouter une ligne dans `at_event_types`. Côté dashboard : normalement rien à changer si le nouveau type utilise les mêmes champs (points, power, rank). Sinon, ajouter un rendu spécifique dans `EventDetailPage` conditionné par `event_type.code`.
