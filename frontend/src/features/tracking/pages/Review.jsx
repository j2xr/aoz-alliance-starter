import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useNeedsReview } from '../hooks/useNeedsReview';
import { isAccessDenied } from '../queries/atQueries';

// Rows the OCR pipeline flagged as low-confidence (needs_review, migration
// 0021). The flag has been written since 0021 but nothing read it back until
// this page — see 0026_at_needs_review_view.sql.

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'participation', label: 'Events' },
  { id: 'donation', label: 'Donations' },
];

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** Confidence colour: the lower the read, the louder it should look. */
function confColor(c) {
  if (c == null) return 'var(--text-faint)';
  if (c < 0.2) return 'var(--danger)';
  if (c < 0.4) return '#fb923c';
  return 'var(--gold)';
}

function ReviewRow({ row, repeatCount }) {
  const navigate = useNavigate();
  const { allianceId } = useParams();
  const isDonation = row.kind === 'donation';

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)',
      borderLeft: `3px solid ${confColor(row.ocr_confidence)}`,
      borderRadius: '10px', padding: '0.8rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
        justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem',
            flexWrap: 'wrap', marginBottom: '0.3rem' }}>
            <span style={{ background: isDonation ? '#ffd7001a' : '#38bdf822',
              color: isDonation ? 'var(--gold)' : 'var(--accent)',
              border: `1px solid ${isDonation ? '#ffd70044' : '#38bdf844'}`,
              borderRadius: '999px', padding: '0.08rem 0.5rem', fontSize: '0.6rem',
              fontFamily: "'Orbitron',sans-serif", letterSpacing: '0.04em' }}>
              {isDonation ? 'DONATION' : 'EVENT'}
            </span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
              {row.context_label} · {formatDate(row.occurred_at)}
            </span>
          </div>

          {/* The OCR'd name is the thing being judged — show it verbatim,
              monospace, so leading/trailing junk and lookalike glyphs are
              actually visible rather than melting into the prose font. */}
          <button
            onClick={() => row.player_id &&
              navigate(`/tracking/alliances/${allianceId}/players/${row.player_id}`)}
            style={{ background: 'transparent', border: 'none', padding: 0,
              cursor: row.player_id ? 'pointer' : 'default', textAlign: 'left',
              fontFamily: 'monospace', fontSize: '0.9rem', fontWeight: '600',
              color: 'var(--text)', wordBreak: 'break-all' }}>
            {row.player_name || '(empty)'}
          </button>

          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
            {row.player_rank ? `${row.player_rank} · ` : ''}
            {Number(row.value).toLocaleString()} {row.value_label}
            {repeatCount > 1 && (
              <span style={{ color: 'var(--text-faint)' }}>
                {' '}· flagged {repeatCount}× for this player
              </span>
            )}
          </div>
        </div>

        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem',
            fontWeight: '700', color: confColor(row.ocr_confidence) }}>
            {row.ocr_confidence == null ? '—' : Number(row.ocr_confidence).toFixed(2)}
          </div>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-faint)' }}>confidence</div>
        </div>
      </div>
    </div>
  );
}

export function ReviewPage() {
  const { allianceId } = useParams();
  const [filter, setFilter] = useState('all');
  const { data: rows = [], isLoading, error } = useNeedsReview(allianceId);

  if (!allianceId) {
    return (
      <div style={{ color: 'var(--text-faint)', textAlign: 'center', padding: '3rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem' }}>
        Select an alliance in the sidebar
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem',
        fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem',
        color: 'var(--text-faint)', letterSpacing: '0.1em' }}>
        LOADING…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: '#ff4d4d0d', border: '1px solid #ff4d4d44',
        borderRadius: '10px', padding: '1.5rem', color: 'var(--danger)', fontSize: '0.85rem' }}>
        {isAccessDenied(error)
          ? 'Access denied — you are not a member of this alliance.'
          : `Error: ${error.message}`}
      </div>
    );
  }

  // A name flagged again and again is usually a font the OCR struggles with,
  // not N separate data errors — worth telling the reviewer before they open
  // the same correction six times.
  const repeatByPlayer = rows.reduce((acc, r) => {
    if (r.player_id) acc[r.player_id] = (acc[r.player_id] ?? 0) + 1;
    return acc;
  }, {});

  const visible = filter === 'all' ? rows : rows.filter(r => r.kind === filter);

  return (
    <div style={{ animation: 'fadeUp 0.25s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '0.62rem', letterSpacing: '0.3em', color: 'var(--accent)',
            textTransform: 'uppercase', fontFamily: "'Orbitron',sans-serif",
            marginBottom: '0.2rem' }}>
            OCR quality
          </div>
          <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.1rem',
            fontWeight: '900', color: 'var(--text)' }}>
            Needs review
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {FILTERS.map(f => {
            const n = f.id === 'all' ? rows.length : rows.filter(r => r.kind === f.id).length;
            const active = filter === f.id;
            return (
              <button key={f.id} onClick={() => setFilter(f.id)}
                style={{
                  background: active ? '#38bdf822' : 'transparent',
                  border: `1px solid ${active ? '#38bdf844' : 'var(--border-strong)'}`,
                  borderRadius: '6px', color: active ? 'var(--accent)' : 'var(--text-muted)',
                  padding: '0.2rem 0.6rem', cursor: 'pointer', fontSize: '0.7rem',
                  fontFamily: "'Orbitron',sans-serif",
                }}>
                {f.label} ({n})
              </button>
            );
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', background: 'var(--bg-panel)',
          border: '1px solid var(--bg-hover)', borderRadius: '12px' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✅</div>
          <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.78rem',
            color: 'var(--text-faint)' }}>
            Nothing flagged for review
          </div>
        </div>
      ) : (
        <>
          <div style={{ background: '#ffd70011', border: '1px solid #ffd70033',
            borderRadius: '8px', padding: '0.6rem 0.85rem', marginBottom: '1rem',
            fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            These rows were read with low confidence and stored anyway. Fix one with{' '}
            <code style={{ fontFamily: 'monospace', color: 'var(--gold)' }}>/correct</code>{' '}
            in Discord, or map a misread name to the right player with{' '}
            <code style={{ fontFamily: 'monospace', color: 'var(--gold)' }}>/player-alias</code>.
          </div>

          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {visible.map(row => (
              <ReviewRow key={`${row.kind}-${row.row_id}`} row={row}
                repeatCount={repeatByPlayer[row.player_id] ?? 1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
