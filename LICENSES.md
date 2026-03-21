# BlindPass Licensing Matrix

BlindPass uses a mixed-license monorepo model. The applicable license depends on the package you are using.

## Package Matrix

| Package | License | Notes |
| :--- | :--- | :--- |
| `packages/sps-server` | `AGPL-3.0-only` | Secret Provisioning Service / trust anchor |
| `packages/dashboard` | `AGPL-3.0-only` | Hosted control plane UI |
| `packages/agent-skill` | `MIT` | Agent-side SDK / skill logic |
| `packages/browser-ui` | `MIT` | Client-side encryption sandbox |
| `packages/gateway` | `MIT` | Interception / delivery middleware |
| `packages/openclaw-plugin` | `MIT` | Runtime integration plugin |

## Repository Notes

- The root workspace package is marked `private` and uses `SEE LICENSE IN LICENSES.md` because the repository contains packages under more than one license.
- Each package includes its own `LICENSE` file and `package.json` license field.
- Source and documentation describing the package split live in `docs/architecture/Licensing_Proposal.md`.

## Boundary Expectations

- MIT packages are intended to remain separable integrations around the protocol and service.
- MIT packages should not vendor or embed AGPL application code.
- If package boundaries change materially, the licensing split should be reviewed again.
