import { PlaceholderPage } from "../components/PlaceholderPage.js";

export function SettingsPage() {
  return (
    <PlaceholderPage
      bullets={[
        "Show workspace metadata with read-only slug and editable display name.",
        "Add hosted deployment controls and environment health later in the phase.",
        "Keep settings surfaced only to workspace administrators."
      ]}
      description="Settings is scaffolded now so the Stitch shell is navigable end to end before later phase work lands."
      eyebrow="Milestone 5+"
      title="Workspace settings"
    />
  );
}
