import { PlaceholderPage } from "../components/PlaceholderPage.js";

export function AnalyticsPage() {
  return (
    <PlaceholderPage
      bullets={[
        "Show business-event charts sourced from audit events only.",
        "Track request volume, exchange outcomes, and active agent counts.",
        "Keep secret names, token values, and raw identities out of the analytics surface."
      ]}
      description="Operators can already reach this page through the shared shell while analytics data waits for Milestone 6."
      eyebrow="Milestone 6"
      title="Analytics"
    />
  );
}
