import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';

function formatTick(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', timeZone: 'UTC',
  });
}

const LINES = [
  { key: 'attack_pct', color: '#38bdf8', label: 'Attack %' },
  { key: 'hp_pct', color: '#22c55e', label: 'HP %' },
  { key: 'defense_pct', color: '#fb923c', label: 'Defense %' },
];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#0f111a', border: '1px solid #2a2d3e',
      borderRadius: '8px', padding: '0.65rem 0.9rem', fontSize: '0.78rem' }}>
      <div style={{ color: '#64748b', marginBottom: '0.4rem' }}>{formatTick(label)}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color, fontFamily: "'Orbitron',sans-serif",
          fontWeight: '700', marginBottom: '0.2rem' }}>
          {p.name} : {p.value != null ? `${Number(p.value).toFixed(1)}%` : '—'}
        </div>
      ))}
    </div>
  );
};

export function StatsEvolutionChart({ data }) {
  if (!data?.length) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: '#4a5568',
        fontSize: '0.78rem', fontFamily: "'Orbitron',sans-serif" }}>
        No data
      </div>
    );
  }

  const chartData = data.map(d => ({
    date: d.recorded_date,
    attack_pct: d.attack_pct != null ? parseFloat(Number(d.attack_pct).toFixed(1)) : null,
    hp_pct: d.hp_pct != null ? parseFloat(Number(d.hp_pct).toFixed(1)) : null,
    defense_pct: d.defense_pct != null ? parseFloat(Number(d.defense_pct).toFixed(1)) : null,
  }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2132" />
        <XAxis
          dataKey="date" tickFormatter={formatTick}
          tick={{ fill: '#4a5568', fontSize: 10 }}
          axisLine={{ stroke: '#1e2132' }} tickLine={false}
        />
        <YAxis
          tick={{ fill: '#4a5568', fontSize: 10 }}
          axisLine={false} tickLine={false}
          tickFormatter={v => `${v}%`}
          domain={[0, 'auto']}
          width={44}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: '0.7rem', color: '#94a3b8', paddingTop: '0.5rem' }} />
        {LINES.map(l => (
          <Line
            key={l.key}
            type="monotone" dataKey={l.key} name={l.label} stroke={l.color}
            strokeWidth={2} dot={{ fill: l.color, r: 3 }}
            activeDot={{ r: 5 }} connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
