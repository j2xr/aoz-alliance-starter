import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';

function formatTick(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', timeZone: 'UTC',
  });
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#0f111a', border: '1px solid #38bdf844',
      borderRadius: '8px', padding: '0.65rem 0.9rem', fontSize: '0.78rem' }}>
      <div style={{ color: '#64748b', marginBottom: '0.3rem' }}>{formatTick(label)}</div>
      <div style={{ color: '#38bdf8', fontFamily: "'Orbitron',sans-serif", fontWeight: '700' }}>
        {payload[0].value?.toLocaleString()} pts
      </div>
    </div>
  );
};

export function PointsEvolutionChart({ data }) {
  if (!data?.length) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: '#4a5568',
        fontSize: '0.78rem', fontFamily: "'Orbitron',sans-serif" }}>
        No data
      </div>
    );
  }

  const chartData = data
    .filter(d => d.event_datetime && d.points != null)
    .map(d => ({ date: d.event_datetime, points: d.points }));

  return (
    <ResponsiveContainer width="100%" height={220}>
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
          tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
          width={40}
        />
        <Tooltip content={<CustomTooltip />} />
        <Line
          type="monotone" dataKey="points" stroke="#38bdf8"
          strokeWidth={2} dot={{ fill: '#38bdf8', r: 3 }}
          activeDot={{ r: 5, fill: '#38bdf8' }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
