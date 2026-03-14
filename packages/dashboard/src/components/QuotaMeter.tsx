interface QuotaMeterProps {
  label: string;
  used: number;
  limit: number;
  helper?: string;
  tone?: "default" | "warning" | "danger";
}

function resolvePercent(used: number, limit: number): number {
  if (limit <= 0) {
    return used > 0 ? 100 : 0;
  }

  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

export function QuotaMeter({ label, used, limit, helper, tone = "default" }: QuotaMeterProps) {
  const percent = resolvePercent(used, limit);

  return (
    <article className={`quota-meter quota-meter--${tone}`}>
      <div className="quota-meter__header">
        <div>
          <div className="card-title">{label}</div>
          {helper ? <p className="hero-card__body">{helper}</p> : null}
        </div>
        <strong className="quota-meter__value">
          {used}/{limit}
        </strong>
      </div>
      <div aria-hidden className="quota-meter__track">
        <span className="quota-meter__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="record-meta">{percent}% used</div>
    </article>
  );
}
