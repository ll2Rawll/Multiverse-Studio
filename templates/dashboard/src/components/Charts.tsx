import { money } from '../metrics.ts';

export function LineChart({ points, label }: { points: { date: string; value: number }[]; label: string }) {
  const w = 640;
  const h = 200;
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p.value / max) * (h - 16)).toFixed(1)}`).join(' ');
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}. Highest day ${money(max)}.`} preserveAspectRatio="none">
        <path d={`${d} L${w},${h} L0,${h} Z`} className="chart-area" />
        <path d={d} className="chart-line" />
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export function BarChart({ bars, label }: { bars: { region: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <figure className="chart">
      <div className="bars" role="img" aria-label={`${label}: ${bars.map((b) => `${b.region} ${money(b.value)}`).join(', ')}`}>
        {bars.map((b) => (
          <div key={b.region} className="bar-row">
            <span>{b.region}</span>
            <div className="bar-track">
              <div className="bar" style={{ width: `${(b.value / max) * 100}%` }} />
            </div>
            <span className="num">{money(b.value)}</span>
          </div>
        ))}
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}
