# @blindpass/browser-ui

Secure, client-side encryption interface for sensitive secret input. This package ensures that plaintext secrets never leave the user's browser in an unencrypted state.

## Security Architecture

The "Secure Secret Input" flow implements a **Zero-Knowledge** handoff to the agent runtime using the following security layers:

### 1. Client-Side Encryption (HPKE)
Secrets are encrypted directly in the browser using the Hybrid Public Key Encryption (**HPKE**) standard.
- **Library**: `hpke-js`
- **Mechanism**: The page retrieves a one-time public key from the Secret Provisioning Service (SPS) and produces a sealed payload.
- **No Plaintext Leaks**: Plaintext values are only stored in local JS memory during the encryption process and are never transmitted to any server.

### 2. Scoped Request Validation
Each input session is tied to a specific request ID and validated via signed links.
- **Metadata Signature**: Allows the browser to fetch the necessary encryption targets (public key, description) securely.
- **Submission Signature**: Authorizes the browser to submit the encrypted payload back to the SPS.
- **Expiration**: Signed links are short-lived and expire automatically.

### 3. Ephemeral Delivery
The system is designed for a single-use exchange.
- Once a secret is submitted, the request is marked as "fulfilled".
- The encrypted payload is held by the SPS until retrieved by the intended agent runtime, after which it is typically purged.

## Development & Testing

### Preview Mode
You can test the UI layout and interaction without a live backend or signed link by adding `?preview=1` to the URL.
- **Note**: No encryption or submission happens in preview mode.

### Verification
```bash
# Run unit tests
npm run test

# Run development server
npm run dev
```

## Alignment
The design and typography are aligned with the **Agent BlindPass Dashboard** (Inter font, glassmorphism, dark theme) to provide a consistent and premium user experience.
