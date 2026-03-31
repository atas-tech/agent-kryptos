import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";

interface ApiKeyRevealProps {
  open: boolean;
  title: string;
  description: string;
  apiKey: string;
  onClose: () => void;
}

export function ApiKeyReveal({ open, title, description, apiKey, onClose }: ApiKeyRevealProps) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  if (!open) {
    return null;
  }

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
  }

  function handleClose(): void {
    if (!confirmed) {
      return;
    }

    setCopied(false);
    setConfirmed(false);
    onClose();
  }

  return (
    <div className="modal-shell" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-shell__backdrop" />
      <div className="modal-card modal-card--highlight">
        <div className="modal-card__header">
          <div className="brand-mark">
            <KeyRound size={18} />
          </div>
          <div>
            <div className="section-label">One-time bootstrap reveal</div>
            <h2 className="modal-card__title">{title}</h2>
          </div>
        </div>

        <p className="modal-card__body">{description}</p>

        <div className="secret-reveal" data-testid="api-key-reveal">
          <code data-testid="revealed-api-key">{apiKey}</code>
          <button className="ghost-button" data-testid="copy-api-key-btn" onClick={() => void handleCopy()} type="button">
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? "Copied" : "Copy key"}
          </button>
        </div>

        <label className="checkbox-row">
          <input
            checked={confirmed}
            data-testid="reveal-save-checkbox"
            onChange={(event) => setConfirmed(event.target.checked)}
            type="checkbox"
          />
          <span>I've saved this key and understand it will not be shown again.</span>
        </label>

        <div className="modal-card__actions">
          <button
            className="primary-button"
            data-testid="reveal-close-btn"
            disabled={!confirmed}
            onClick={handleClose}
            type="button"
          >
            I saved this key
          </button>
        </div>
      </div>
    </div>
  );
}
