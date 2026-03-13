import { PlaceholderPage } from "../components/PlaceholderPage.js";

export function AuditPage() {
  return (
    <PlaceholderPage
      bullets={[
        "Paginated audit list with event, actor, resource, and date filters.",
        "Masked metadata rendering to avoid ciphertext or API key exposure.",
        "Exchange drill-down with chronological state transitions."
      ]}
      description="Viewer-safe audit access is already routable, which lets role-based redirects and nav hiding be tested now."
      eyebrow="Milestone 4"
      title="Audit log viewer"
    />
  );
}
