import { supabase } from './supabase.js';

export type CorrectionField = 'points' | 'power' | 'honor';
export type CorrectionTable = 'at_participations' | 'at_donations';

/**
 * Applies a single-field correction via the `at_apply_correction` DB function
 * (migration 0023): reads the current value, writes the new one, and inserts
 * the at_corrections audit row, all inside one Postgres transaction. Shared by
 * /correct (manual) and /reprocess-line (LLM-suggested), so both go through the
 * same audited, single-entry write instead of a raw .update() + .insert() pair
 * (which left a window where the score changed but the audit insert could fail).
 *
 * Callers are expected to have already verified the target row exists so a
 * genuinely missing target gets a friendly message; this function's generic
 * P0002 "not found" is only reachable via a TOCTOU race.
 */
export async function applyCorrection(params: {
  targetTable: CorrectionTable;
  targetId: string;
  field: CorrectionField;
  newValue: number;
  allianceId: string;
  playerId: string;
  correctedBy: string;
}): Promise<{ oldValue: number | null; newValue: number }> {
  const { data, error } = await supabase
    .rpc('at_apply_correction', {
      p_target_table: params.targetTable,
      p_target_id: params.targetId,
      p_field: params.field,
      p_new_value: params.newValue,
      p_alliance_id: params.allianceId,
      p_player_id: params.playerId,
      p_corrected_by: params.correctedBy,
    })
    .single();

  if (error) throw new Error(`Failed to apply correction: ${error.message}`);
  const row = data as { old_value: number | null; new_value: number };
  return { oldValue: row.old_value, newValue: row.new_value };
}
