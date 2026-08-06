// Import quality = how many rows the game's header declared for an event vs.
// how many the OCR import actually landed.
//
// The verdict deliberately uses the ROW COUNT only. The header's "total points"
// is NOT the sum of the members' points for every event type (measured: it is
// for battle_frenzy and void_war, but off by 20-260x for elite_wars,
// polar_invasion and wasteland_showdown, where it is an alliance-level score).
// See supabase/migrations/0025_at_event_import_delta.sql for the measurements.
// Point totals are therefore shown as raw context, never compared.

const OK_PCT = 99.5;   // rounding slack: the view rounds coverage to 1 decimal
const WARN_PCT = 90;

/** Verdict shared by the badge and the panel so they can never disagree. */
export function importVerdict(row) {
  if (!row) return { level: 'unknown', label: 'No data' };
  const pct = row.battlers_coverage_pct;
  // No declared fighter count — nothing to compare against. Must not read as
  // success just because there is no evidence of failure.
  if (pct == null) return { level: 'unknown', label: 'No official count' };

  const v = Number(pct);
  if (v > 100.5) return { level: 'warn', label: `${v}% — more rows than declared` };
  if (v >= OK_PCT) return { level: 'ok', label: 'Complete' };
  if (v >= WARN_PCT) return { level: 'warn', label: `${v}% imported` };
  return { level: 'bad', label: `${v}% imported` };
}

const LEVEL_COLOR = {
  ok: 'var(--success)',
  warn: 'var(--gold)',
  bad: 'var(--danger)',
  unknown: 'var(--text-faint)',
};

function badgeTitle(row, verdict) {
  if (verdict.level === 'unknown') {
    return 'The screenshot header did not yield a fighter count for this event, so import completeness cannot be checked.';
  }
  return `${row.imported_players} of ${row.official_battlers} declared fighters imported`;
}

/** Compact pill for list/card contexts. */
export function ImportQualityBadge({ row }) {
  const verdict = importVerdict(row);
  const color = LEVEL_COLOR[verdict.level];
  return (
    <span
      title={badgeTitle(row, verdict)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
        background: 'transparent', border: `1px solid ${color}55`, color,
        borderRadius: '999px', padding: '0.1rem 0.5rem',
        fontSize: '0.62rem', fontFamily: "'Orbitron',sans-serif",
        letterSpacing: '0.03em', whiteSpace: 'nowrap',
      }}>
      <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: color }} />
      {verdict.label}
    </span>
  );
}

function Stat({ value, label, color = 'var(--text)', title }) {
  return (
    <div style={{ textAlign: 'center' }} title={title}>
      <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.15rem',
        fontWeight: '900', color }}>
        {value}
      </div>
      <div style={{ fontSize: '0.6rem', color: 'var(--text-faint)' }}>{label}</div>
    </div>
  );
}

function fmt(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

/** Signed, so "7 missing" and "2 extra" can't be confused. */
function fmtDelta(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (v === 0) return '0';
  return v > 0 ? `${v.toLocaleString()} missing` : `${Math.abs(v).toLocaleString()} extra`;
}

function deltaColor(n) {
  if (n == null) return 'var(--text-faint)';
  return Number(n) === 0 ? 'var(--success)' : 'var(--danger)';
}

/** Full panel for the event detail page. */
export function ImportQualityPanel({ row, loading, error }) {
  if (loading) {
    return (
      <div style={{ padding: '1.25rem', color: 'var(--text-faint)',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.72rem' }}>
        LOADING…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: '1.25rem', color: 'var(--danger)', fontSize: '0.8rem' }}>
        Error: {error.message}
      </div>
    );
  }
  if (!row) return null;

  const verdict = importVerdict(row);

  return (
    <div style={{ padding: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
        marginBottom: '1rem', flexWrap: 'wrap' }}>
        <ImportQualityBadge row={row} />
        {row.needs_review_rows > 0 && (
          <span style={{ fontSize: '0.7rem', color: 'var(--gold)' }}>
            · {row.needs_review_rows} row{row.needs_review_rows > 1 ? 's' : ''} flagged low-confidence
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: '1.75rem', flexWrap: 'wrap' }}>
        <Stat value={fmt(row.official_battlers)} label="Declared fighters"
          title="Fighter count read from the screenshot header" />
        <Stat value={fmt(row.imported_players)} label="Imported rows" color="var(--accent)"
          title="Participation rows actually stored for this event" />
        <Stat value={fmtDelta(row.battlers_delta)} label="Difference"
          color={deltaColor(row.battlers_delta)}
          title="Declared minus imported. Missing rows usually mean a leaderboard page was never uploaded." />
        <Stat value={fmt(row.scoring_players)} label="Scored > 0" />
      </div>

      {/* Points: context only — see the header comment on unit mismatch. */}
      <div style={{ display: 'flex', gap: '1.75rem', flexWrap: 'wrap', marginTop: '1.1rem',
        paddingTop: '1.1rem', borderTop: '1px solid var(--border)' }}>
        <Stat value={fmt(row.imported_points)} label="Imported points"
          title="Sum of the imported rows' points" />
        <Stat value={fmt(row.official_points)} label="Header total" color="var(--text-dim)"
          title="Figure printed in the screenshot header. Depending on the event type this is an alliance-level score, not the sum of member points — the two are not comparable." />
      </div>

      {verdict.level === 'unknown' && (
        <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
          No fighter count was read from this event's header, so completeness
          can't be verified — only the imported figures above are known.
        </div>
      )}
      {row.battlers_delta > 0 && (
        <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
          {row.battlers_delta} declared fighter{row.battlers_delta > 1 ? 's are' : ' is'} missing
          from the import — most often a leaderboard page that was never uploaded.
        </div>
      )}
    </div>
  );
}
