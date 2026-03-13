import { Bot, Plus } from "lucide-react";
import { PlaceholderPage } from "../components/PlaceholderPage.js";

export function AgentsPage() {
  return (
    <PlaceholderPage
      actions={
        <button className="primary-button" type="button">
          <Plus size={16} />
          Enroll agent
        </button>
      }
      bullets={[
        "List agents with status, created timestamp, and rotation actions.",
        "Expose one-time bootstrap API key reveal after enrollment and rotation.",
        "Allow revoke actions for admins and operators with confirmation flow."
      ]}
      description="This shell route is ready for Milestone 3 CRUD work and already respects operator access."
      eyebrow="Milestone 3"
      title="Agent management"
    />
  );
}
