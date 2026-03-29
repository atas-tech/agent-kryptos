import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface EmptyStateProps {
  title: string;
  body: string;
  action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  const { t } = useTranslation("common");

  return (
    <div className="empty-state">
      <div className="empty-state__eyebrow">{t("noRecordsYet")}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
