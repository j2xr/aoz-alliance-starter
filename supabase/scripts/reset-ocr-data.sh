#!/bin/bash
# reset-ocr-data.sh
#
# Équivalent REST de reset-ocr-data.sql, pour les environnements où
# `supabase db query --linked` n'est pas utilisable (ex: pas de token CLI
# login sur cette machine, pas de psql/DATABASE_URL en fallback). Utilise la
# service-role key pour DELETE chaque table via PostgREST (bypass RLS), dans
# un ordre FK-safe (feuilles d'abord) puisque REST n'a pas l'atomicité
# multi-tables d'un TRUNCATE.
#
# Usage :
#   supabase/scripts/reset-ocr-data.sh [chemin/vers/.env]
#
# Par défaut, source tracker/apps/ocr-service/.env (ou
# tracker/apps/discord-bot/.env, les deux pointent le même projet Supabase
# lié) pour SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
#
# Conservé / nettoyé : voir reset-ocr-data.sql, notamment la note sur
# at_screenshot_uploads (dédup reprocess-channel) et at_player_aliases
# (cascade depuis at_players).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${1:-$script_dir/../../tracker/apps/ocr-service/.env}"

if [[ ! -f "$env_file" ]]; then
  echo "Fichier .env introuvable: $env_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

: "${SUPABASE_URL:?SUPABASE_URL manquant dans $env_file}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY manquant dans $env_file}"

# Ordre FK-safe, feuilles d'abord (voir reset-ocr-data.sql pour le détail
# des dépendances, notamment at_corrections -> at_players ajoutée en
# migration 0022).
TABLES=(
  at_donations
  at_player_stats
  at_corrections
  at_player_aliases
  at_participations
  at_alliance_memberships
  at_donation_periods
  at_screenshot_uploads
  at_events
  at_players
)

echo "--- suppression ---"
for t in "${TABLES[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Prefer: return=minimal" \
    "$SUPABASE_URL/rest/v1/$t?id=not.is.null")
  echo "DELETE $t -> $code"
done

echo "--- vérification (doit être 0, sauf tables préservées) ---"
for t in "${TABLES[@]}" at_alliances at_event_types; do
  range=$(curl -s -D - -o /dev/null -X HEAD \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Prefer: count=exact" \
    -H "Range: 0-0" \
    "$SUPABASE_URL/rest/v1/$t?select=id" | grep -i '^content-range:' | tr -d '\r')
  echo "$t: $range"
done
