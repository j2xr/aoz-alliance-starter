#!/bin/bash
# reset-ocr-data.sh
#
# REST equivalent of reset-ocr-data.sql, for environments where
# `supabase db query --linked` isn't usable (e.g. no CLI login token on
# this machine, no psql/DATABASE_URL fallback). Uses the service-role key
# to DELETE each table via PostgREST (bypasses RLS), in FK-safe order
# (leaves first) since REST doesn't have a TRUNCATE's multi-table atomicity.
#
# Usage:
#   supabase/scripts/reset-ocr-data.sh [path/to/.env]
#
# By default, sources tracker/apps/ocr-service/.env (or
# tracker/apps/discord-bot/.env, both point to the same linked Supabase
# project) for SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
#
# Preserved / cleaned: see reset-ocr-data.sql, in particular the note on
# at_screenshot_uploads (reprocess-channel dedup) and at_player_aliases
# (cascade from at_players).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${1:-$script_dir/../../tracker/apps/ocr-service/.env}"

if [[ ! -f "$env_file" ]]; then
  echo ".env file not found: $env_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

: "${SUPABASE_URL:?SUPABASE_URL missing from $env_file}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY missing from $env_file}"

# FK-safe order, leaves first (see reset-ocr-data.sql for the dependency
# details, in particular at_corrections -> at_players added in
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

echo "--- deleting ---"
for t in "${TABLES[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Prefer: return=minimal" \
    "$SUPABASE_URL/rest/v1/$t?id=not.is.null")
  echo "DELETE $t -> $code"
done

echo "--- verification (should be 0, except preserved tables) ---"
for t in "${TABLES[@]}" at_alliances at_event_types; do
  range=$(curl -s -D - -o /dev/null -X HEAD \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Prefer: count=exact" \
    -H "Range: 0-0" \
    "$SUPABASE_URL/rest/v1/$t?select=id" | grep -i '^content-range:' | tr -d '\r')
  echo "$t: $range"
done
