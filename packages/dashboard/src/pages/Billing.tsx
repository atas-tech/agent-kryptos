import { PlaceholderPage } from "../components/PlaceholderPage.js";

export function BillingPage() {
  return (
    <PlaceholderPage
      bullets={[
        "Expose current tier, billing state, and quota meters from the summary endpoint.",
        "Launch Stripe checkout or customer portal depending on workspace tier.",
        "Keep the billing surface admin-only in the MVP."
      ]}
      description="The shell route exists now so admins can navigate the full hosted control surface from day one."
      eyebrow="Milestone 5"
      title="Billing and quota"
    />
  );
}
