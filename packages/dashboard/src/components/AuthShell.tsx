import { ShieldCheck } from "lucide-react";
import type { PropsWithChildren, ReactNode } from "react";

interface AuthShellProps {
  title: string;
  subtitle: string;
  eyebrow: string;
  heroTitle: ReactNode;
  heroBody: string;
  metrics: Array<{ label: string; value: string }>;
  footer?: ReactNode;
}

export function AuthShell({
  children,
  title,
  subtitle,
  eyebrow,
  heroTitle,
  heroBody,
  metrics,
  footer
}: PropsWithChildren<AuthShellProps>) {
  return (
    <div className="auth-shell">
      <aside className="auth-shell__hero">
        <div className="auth-shell__mesh" />
        <div className="auth-shell__hero-content">
          <div className="auth-shell__brand">
            <div className="brand-mark">
              <ShieldCheck size={18} />
            </div>
            <span>agent-BlindPass</span>
          </div>

          <div className="auth-shell__hero-copy">
            <div className="section-label">{eyebrow}</div>
            <h1>{heroTitle}</h1>
            <p>{heroBody}</p>
          </div>

          <div className="auth-shell__metrics">
            {metrics.map((metric) => (
              <div key={metric.label} className="auth-shell__metric">
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <section className="auth-shell__panel">
        <div className="auth-shell__panel-inner">
          <div className="auth-shell__panel-header">
            <div className="auth-mobile-brand">
              <div className="brand-mark">
                <ShieldCheck size={18} />
              </div>
              <span>agent-BlindPass</span>
            </div>
            <div className="section-label">{eyebrow}</div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          {children}
          {footer ? <div className="auth-shell__footer">{footer}</div> : null}
        </div>
      </section>
    </div>
  );
}
