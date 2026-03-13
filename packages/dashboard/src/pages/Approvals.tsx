import { PlaceholderPage } from "../components/PlaceholderPage.js";

export function ApprovalsPage() {
  return (
    <PlaceholderPage
      bullets={[
        "Render pending exchange approvals with decision actions.",
        "Allow viewers to inspect entries while disabling approval controls.",
        "Wire action buttons to future approve and deny endpoints."
      ]}
      description="The approvals inbox route is available to all workspace roles and ready for Milestone 4 action wiring."
      eyebrow="Milestone 4"
      title="Approvals inbox"
    />
  );
}
