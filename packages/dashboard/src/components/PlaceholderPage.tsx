import type { ReactNode } from "react";

interface PlaceholderPageProps {
  title: string;
  eyebrow: string;
  description: string;
  actions?: ReactNode;
  bullets: string[];
}

export function PlaceholderPage({ title, eyebrow, description, actions, bullets }: PlaceholderPageProps) {
  return (
    <section className="page-stack">
      <div className="hero-card">
        <div>
          <div className="section-label">{eyebrow}</div>
          <h2 className="hero-card__title">{title}</h2>
          <p className="hero-card__body">{description}</p>
        </div>
        {actions ? <div className="hero-card__actions">{actions}</div> : null}
      </div>

      <div className="content-grid">
        <article className="info-card">
          <div className="card-title">Planned slices</div>
          <ul className="feature-list">
            {bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        </article>

        <article className="info-card">
          <div className="card-title">Implementation status</div>
          <p className="hero-card__body">
            This route is scaffolded in Milestone 2 so navigation, role routing, and responsive layout are testable
            before the CRUD and analytics features land.
          </p>
          <div className="status-grid">
            <div className="status-card">
              <strong>Shell</strong>
              <span>Live</span>
            </div>
            <div className="status-card">
              <strong>API wiring</strong>
              <span>Next milestone</span>
            </div>
            <div className="status-card">
              <strong>Responsive pass</strong>
              <span>Ready</span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
