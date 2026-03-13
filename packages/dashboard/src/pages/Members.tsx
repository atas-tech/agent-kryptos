import { PlaceholderPage } from "../components/PlaceholderPage.js";

export function MembersPage() {
  return (
    <PlaceholderPage
      bullets={[
        "Create members with temporary passwords and forced password change on first login.",
        "Support role changes, suspension, and last-admin safety checks.",
        "Keep admin-only access enforced from navigation through route guards."
      ]}
      description="This admin route is scaffolded so the full shell is clickable before member CRUD arrives."
      eyebrow="Milestone 3"
      title="Member management"
    />
  );
}
