import { supabase } from '@/lib/supabase';

// PostgREST returns PGRST116 ("JSON object requested, multiple (or no) rows
// returned") when a RLS policy silently filters out every row instead of a
// clean 403 -- the same shape a genuine "no rows" case would produce, but
// here it means the caller isn't a member of the alliance they queried.
// Matching on error.code (not the message string) survives PostgREST/locale
// wording changes.
export function isAccessDenied(error) {
  return error?.code === 'PGRST116';
}

export async function fetchUserAlliances() {
  const { data, error } = await supabase
    .from('at_alliance_members')
    .select('role, at_alliances(id, name)')
    .order('at_alliances(name)');
  if (error) throw error;
  return (data ?? []).map(row => ({
    id: row.at_alliances.id,
    name: row.at_alliances.name,
    tag: null,
    role: row.role,
  }));
}

export async function fetchAllianceEvents(allianceId, limit = 20) {
  const { data, error } = await supabase
    .from('at_events')
    .select('id, event_datetime, alliance_rank, total_battlers, total_points, at_event_types(code, display_name)')
    .eq('alliance_id', allianceId)
    .order('event_datetime', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function fetchAllianceEvent(eventId) {
  const { data, error } = await supabase
    .from('at_events')
    .select('id, event_datetime, alliance_rank, total_battlers, total_points, at_event_types(code, display_name)')
    .eq('id', eventId)
    .single();
  if (error) throw error;
  return data;
}

export async function fetchEventLeaderboard(eventId) {
  const { data, error } = await supabase
    .from('at_v_event_leaderboard')
    .select('*')
    .eq('event_id', eventId)
    .order('position');
  if (error) throw error;
  return data ?? [];
}

export async function fetchParticipationRate(allianceId, playerId) {
  // Ligne unique pour la page détail joueur : charger toute la vue de
  // l'alliance pour n'en garder qu'une ligne transférait N lignes pour rien.
  const { data, error } = await supabase
    .from('at_v_player_participation_rate')
    .select('*')
    .eq('alliance_id', allianceId)
    .eq('player_id', playerId)
    .maybeSingle();
  if (error) throw error;
  return data; // null quand le joueur n'a aucune ligne
}

export async function fetchParticipationRates(allianceId) {
  const { data, error } = await supabase
    .from('at_v_player_participation_rate')
    .select('*')
    .eq('alliance_id', allianceId)
    .order('participation_rate_pct', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchPlayerStats(playerId, allianceId) {
  const { data, error } = await supabase
    .from('at_participations')
    .select('points, power, at_events(event_datetime, at_event_types(code))')
    .eq('player_id', playerId)
    .eq('at_events.alliance_id', allianceId)
    .order('at_events(event_datetime)', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(row => ({
    event_datetime: row.at_events?.event_datetime ?? null,
    points: row.points,
    power: row.power,
    event_type_code: row.at_events?.at_event_types?.code ?? null,
  }));
}

export async function fetchAlliancePlayer(playerId) {
  const { data, error } = await supabase
    .from('at_players')
    .select('id, name')
    .eq('id', playerId)
    .single();
  if (error) throw error;
  return data;
}

export async function fetchDonationPeriods(allianceId) {
  const { data, error } = await supabase
    .from('at_donation_periods')
    .select('id, period_type, period_start, period_end')
    .eq('alliance_id', allianceId)
    .eq('period_type', 'weekly')
    .order('period_start', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchDonationLeaderboard(periodId) {
  const { data, error } = await supabase
    .from('at_v_donation_leaderboard')
    .select('donation_period_id, alliance_id, period_type, period_start, period_end, alliance_name, player_id, player_name, player_rank, alliance_honor, updated_at, position')
    .eq('donation_period_id', periodId)
    .order('position', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function fetchPlayerDonationTotals(playerId) {
  const { data, error } = await supabase
    .from('at_v_donation_player_totals')
    .select('alliance_id, player_id, name, periods_contributed, total_alliance_honor, best_period_honor, avg_per_period, last_period_start')
    .eq('player_id', playerId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchPlayerStatsLatest(allianceId) {
  const { data, error } = await supabase
    .from('at_v_player_stats_latest')
    .select('*')
    .eq('alliance_id', allianceId)
    .order('attack_pct', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchPlayerStatsHistory(allianceId, playerId) {
  const { data, error } = await supabase
    .from('at_v_player_stats_history')
    .select('*')
    .eq('alliance_id', allianceId)
    .eq('player_id', playerId)
    .order('recorded_date', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function fetchPlayerDonationHistory(playerId, limit = 5) {
  const { data, error } = await supabase
    .from('at_donations')
    .select('id, alliance_honor, updated_at, at_donation_periods!inner(id, period_start, period_end, period_type)')
    .eq('player_id', playerId)
    .eq('at_donation_periods.period_type', 'weekly')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(row => ({
    id: row.id,
    alliance_honor: row.alliance_honor,
    updated_at: row.updated_at,
    period_id: row.at_donation_periods?.id ?? null,
    period_start: row.at_donation_periods?.period_start ?? null,
    period_end: row.at_donation_periods?.period_end ?? null,
  }));
}
