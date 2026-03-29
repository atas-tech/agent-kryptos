import { useTranslation } from "react-i18next";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  pending?: boolean;
  tone?: "danger" | "neutral";
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  pending = false,
  tone = "danger",
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const { t } = useTranslation("common");

  if (!open) {
    return null;
  }

  return (
    <div className="modal-shell" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label={t("closeDialog")} className="modal-shell__backdrop" onClick={onCancel} type="button" />
      <div className="modal-card">
        <div className="section-label">{t("confirmationRequired")}</div>
        <h2 className="modal-card__title">{title}</h2>
        <p className="modal-card__body">{body}</p>
        <div className="modal-card__actions">
          <button className="ghost-button" disabled={pending} onClick={onCancel} type="button">
            {t("cancel")}
          </button>
          <button
            className={`primary-button ${tone === "danger" ? "primary-button--danger" : ""}`}
            disabled={pending}
            onClick={() => void onConfirm()}
            type="button"
            data-testid="confirm-dialog-btn"
          >
            {pending ? t("working") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
