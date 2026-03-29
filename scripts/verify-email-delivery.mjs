import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env from sps-server/.env.test
config({ path: resolve(__dirname, "../packages/sps-server/.env.test") });

async function run() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SPS_EMAIL_FROM;
  const targetEmail = process.argv[2] || "hvo@atas.tech";

  if (!apiKey || !from) {
    console.error("RESEND_API_KEY and SPS_EMAIL_FROM must be set in .env.test");
    process.exit(1);
  }

  console.log(`Testing email delivery to ${targetEmail} from ${from} using Resend...`);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [targetEmail],
      subject: "BlindPass Email Integration Test",
      html: "<p>This is a test email from the BlindPass ecosystem verifying Resend integration.</p>",
      text: "This is a test email from the BlindPass ecosystem verifying Resend integration."
    })
  });

  const data = await response.json();
  if (response.ok) {
    console.log("✅ Success! Email sent. Resend ID:", data.id);
  } else {
    console.error("❌ Failed to send email:", data);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
