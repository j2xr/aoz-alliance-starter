import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip,
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
    <div style={{ background: '#0f111a', border: '1px solid #a78bfa44',
      borderRadius: '8px', padding: '0.65rem 0.9rem', fontSize: '0.78rem' }}>
      <div style={{ color: '#64748b', marginBottom: '0.3rem' }}>{formatTick(label)}</div>
      <div style={{ color: '#a78bfa', fontFamily: "'Orbitron',sans-serif", fontWeight: '700' }}>
        {payload[0].value?.toLocaleString()} pwr
      </div>
    </div>
  );
};

export function PowerHistoryChart({ data }) {
  if (!data?.length) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: '#4a5568',
        fontSize: '0.78rem', fontFamily: "'Orbitron',sans-serif" }}>
        No data
      </div>
    );
  }

  const chartData = data
    .filter(d => d.event_datetime && d.power != null)
    .map(d => ({ date: d.event_datetime, power: d.power }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="powerGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2132" />
        <XAxis
          dataKey="date" tickFormatter={formatTick}
          tick={{ fill: '#4a5568', fontSize: 10 }}
          axisLine={{ stroke: '#1e2132' }} tickLine={false}
        />
        <YAxis
          tick={{ fill: '#4a5568', fontSize: 10 }}
          axisLine={false} tickLine={false}
          tickFormatter={v => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
          width={48}
        />
        <Tooltip content={<CustomTooltip />} />
        <Area
          type="monotone" dataKey="power" stroke="#a78bfa"
          strokeWidth={2} fill="url(#powerGrad)"
          dot={{ fill: '#a78bfa', r: 3 }}
          activeDot={{ r: 5, fill: '#a78bfa' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
