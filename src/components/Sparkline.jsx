// Lightweight SVG dual-line chart. No deps.
// `series` is [{ label, color, points: [{ x, y }] }, ...] — x can be any
// monotonic numeric (we use unix-day for game-by-game time series).
// Y axis is fixed 0..100.

const W = 460;
const H = 140;
const PAD = { t: 12, r: 14, b: 22, l: 28 };

function scaleX(x, minX, maxX) {
  if (maxX === minX) return PAD.l + (W - PAD.l - PAD.r) / 2;
  return PAD.l + ((x - minX) / (maxX - minX)) * (W - PAD.l - PAD.r);
}

function scaleY(y) {
  return PAD.t + (1 - y / 100) * (H - PAD.t - PAD.b);
}

function buildPath(points, minX, maxX) {
  if (!points.length) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(p.x, minX, maxX).toFixed(1)},${scaleY(p.y).toFixed(1)}`)
    .join(' ');
}

export default function Sparkline({ series, ariaLabel }) {
  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);

  if (!Number.isFinite(minX)) {
    return (
      <div className="chart-empty" aria-label={ariaLabel}>
        No data in this window
      </div>
    );
  }

  const yTicks = [0, 25, 50, 75, 100];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="chart-svg"
      role="img"
      aria-label={ariaLabel}
    >
      {/* grid */}
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.l} x2={W - PAD.r}
            y1={scaleY(t)} y2={scaleY(t)}
            stroke="rgba(0,0,0,0.06)"
            strokeWidth="1"
          />
          <text
            x={PAD.l - 6}
            y={scaleY(t) + 3}
            textAnchor="end"
            className="chart-tick"
          >
            {t}%
          </text>
        </g>
      ))}

      {/* X axis labels: first + last */}
      <text x={PAD.l} y={H - 6} className="chart-tick" textAnchor="start">
        {fmtDay(minX)}
      </text>
      <text x={W - PAD.r} y={H - 6} className="chart-tick" textAnchor="end">
        {fmtDay(maxX)}
      </text>

      {/* series */}
      {series.map((s) => (
        <g key={s.label}>
          <path
            d={buildPath(s.points, minX, maxX)}
            fill="none"
            stroke={s.color}
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={s.dashed ? '4 3' : undefined}
          />
          {s.points.map((p, i) => (
            <circle
              key={i}
              cx={scaleX(p.x, minX, maxX)}
              cy={scaleY(p.y)}
              r="2.4"
              fill={s.color}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}

function fmtDay(unixDay) {
  const d = new Date(unixDay * 86400000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
