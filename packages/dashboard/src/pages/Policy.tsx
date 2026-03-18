import { AlertTriangle, CheckCircle2, FileCode2, Plus, RefreshCw, Save, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client.js";
import {
  getWorkspacePolicy,
  updateWorkspacePolicy,
  validateWorkspacePolicy,
  type ExchangePolicyRule,
  type SecretRegistryEntry,
  type WorkspacePolicyRecord,
  type WorkspacePolicyValidationIssue
} from "../api/dashboard.js";
import { useAuth } from "../auth/useAuth.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface PolicyDraft {
  secretRegistry: SecretRegistryEntry[];
  exchangePolicy: ExchangePolicyRule[];
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function emptySecretRegistryEntry(): SecretRegistryEntry {
  return {
    secretName: "",
    classification: "",
    description: ""
  };
}

function emptyExchangeRule(): ExchangePolicyRule {
  return {
    ruleId: "",
    secretName: "",
    requesterIds: [],
    fulfillerIds: [],
    approverIds: [],
    requesterRings: [],
    fulfillerRings: [],
    approverRings: [],
    purposes: [],
    allowedRings: [],
    sameRing: false,
    mode: "allow",
    approvalReference: "",
    reason: ""
  };
}

function toDraft(policy: WorkspacePolicyRecord | null): PolicyDraft {
  if (!policy) {
    return {
      secretRegistry: [emptySecretRegistryEntry()],
      exchangePolicy: [emptyExchangeRule()]
    };
  }

  return {
    secretRegistry: policy.secret_registry.length > 0
      ? policy.secret_registry.map((entry) => ({ ...entry }))
      : [emptySecretRegistryEntry()],
    exchangePolicy: policy.exchange_policy.length > 0
      ? policy.exchange_policy.map((rule) => ({
          ...rule,
          requesterIds: [...(rule.requesterIds ?? [])],
          fulfillerIds: [...(rule.fulfillerIds ?? [])],
          approverIds: [...(rule.approverIds ?? [])],
          requesterRings: [...(rule.requesterRings ?? [])],
          fulfillerRings: [...(rule.fulfillerRings ?? [])],
          approverRings: [...(rule.approverRings ?? [])],
          purposes: [...(rule.purposes ?? [])],
          allowedRings: [...(rule.allowedRings ?? [])]
        }))
      : [emptyExchangeRule()]
  };
}

function parseListInput(value: string): string[] | undefined {
  const entries = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : undefined;
}

function toListInput(values: string[] | undefined): string {
  return values?.join(", ") ?? "";
}

function normalizeDraft(draft: PolicyDraft): PolicyDraft {
  return {
    secretRegistry: draft.secretRegistry
      .map((entry) => ({
        secretName: entry.secretName.trim(),
        classification: entry.classification.trim(),
        description: entry.description?.trim() || undefined
      }))
      .filter((entry) => entry.secretName || entry.classification || entry.description),
    exchangePolicy: draft.exchangePolicy
      .map((rule) => ({
        ruleId: rule.ruleId.trim(),
        secretName: rule.secretName.trim(),
        requesterIds: rule.requesterIds?.filter(Boolean),
        fulfillerIds: rule.fulfillerIds?.filter(Boolean),
        approverIds: rule.approverIds?.filter(Boolean),
        requesterRings: rule.requesterRings?.filter(Boolean),
        fulfillerRings: rule.fulfillerRings?.filter(Boolean),
        approverRings: rule.approverRings?.filter(Boolean),
        purposes: rule.purposes?.filter(Boolean),
        allowedRings: rule.allowedRings?.filter(Boolean),
        sameRing: rule.sameRing ?? false,
        mode: rule.mode ?? "allow",
        approvalReference: rule.approvalReference?.trim() || undefined,
        reason: rule.reason?.trim() || undefined
      }))
      .filter((rule) => rule.ruleId || rule.secretName || (rule.purposes?.length ?? 0) > 0)
  };
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "Not available";
  }

  return dateFormatter.format(new Date(value));
}

function countConfiguredSecrets(entries: SecretRegistryEntry[]): number {
  return entries.filter((entry) => entry.secretName.trim() || entry.classification.trim() || entry.description?.trim()).length;
}

function countConfiguredRules(rules: ExchangePolicyRule[]): number {
  return rules.filter((rule) => rule.ruleId.trim() || rule.secretName.trim() || (rule.purposes?.length ?? 0) > 0).length;
}

function formatSourceLabel(source: string): string {
  return source.replaceAll("_", " ");
}

function classificationTone(classification: string): "danger" | "warning" | "success" | "neutral" {
  const normalized = classification.trim().toLowerCase();
  if (normalized.includes("restricted") || normalized.includes("prod") || normalized.includes("finance")) {
    return "danger";
  }
  if (normalized.includes("sensitive") || normalized.includes("approval")) {
    return "warning";
  }
  if (normalized.includes("internal") || normalized.includes("shared")) {
    return "success";
  }
  return "neutral";
}

export function PolicyPage() {
  const { user } = useAuth();
  const isReadOnly = user?.role === "workspace_operator";

  const [policy, setPolicy] = useState<WorkspacePolicyRecord | null>(null);
  const [draft, setDraft] = useState<PolicyDraft>(() => toDraft(null));
  const [issues, setIssues] = useState<WorkspacePolicyValidationIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void loadPolicy();
  }, []);

  const hasUnsavedChanges = useMemo(() => {
    return JSON.stringify(normalizeDraft(draft)) !== JSON.stringify(normalizeDraft(toDraft(policy)));
  }, [draft, policy]);

  async function loadPolicy() {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const payload = await getWorkspacePolicy();
      setPolicy(payload.policy);
      setDraft(toDraft(payload.policy));
      setIssues([]);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === "workspace_policy_not_found") {
        setPolicy(null);
        setDraft(toDraft(null));
        setIssues([]);
        return;
      }

      setError(requestError instanceof Error ? requestError.message : "Unable to load workspace policy");
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await loadPolicy();
    setRefreshing(false);
  }

  async function handleValidate() {
    setValidating(true);
    setError(null);
    setSuccess(null);

    try {
      const normalized = normalizeDraft(draft);
      const payload = await validateWorkspacePolicy({
        secret_registry: normalized.secretRegistry,
        exchange_policy: normalized.exchangePolicy
      });

      setIssues(payload.issues);
      setSuccess(payload.valid ? "Policy validation passed." : "Policy validation returned issues.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to validate policy");
    } finally {
      setValidating(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const normalized = normalizeDraft(draft);
      const payload = await updateWorkspacePolicy({
        expected_version: policy?.version ?? 0,
        secret_registry: normalized.secretRegistry,
        exchange_policy: normalized.exchangePolicy
      });

      setPolicy(payload.policy);
      setDraft(toDraft(payload.policy));
      setIssues([]);
      setSuccess(`Policy saved as version ${payload.policy.version}.`);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === "workspace_policy_invalid") {
        const invalidIssues = Array.isArray(requestError.issues) ? (requestError.issues as WorkspacePolicyValidationIssue[]) : [];
        setIssues(invalidIssues);
      }

      setError(requestError instanceof Error ? requestError.message : "Unable to save policy");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setDraft(toDraft(policy));
    setIssues([]);
    setError(null);
    setSuccess(null);
  }

  function updateRegistryEntry(index: number, field: keyof SecretRegistryEntry, value: string) {
    setDraft((current) => {
      const secretRegistry = current.secretRegistry.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [field]: value } : entry
      );
      return { ...current, secretRegistry };
    });
  }

  function updateRule(index: number, patch: Partial<ExchangePolicyRule>) {
    setDraft((current) => {
      const exchangePolicy = current.exchangePolicy.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...patch } : rule
      );
      return { ...current, exchangePolicy };
    });
  }

  const summarySource = policy?.source ?? "draft";
  const summaryVersion = policy?.version ?? 0;
  const summaryUpdatedAt = policy?.updated_at ?? null;
  const summaryUpdatedBy = policy?.updated_by_user_id ?? "platform bootstrap";
  const configuredSecrets = countConfiguredSecrets(draft.secretRegistry);
  const configuredRules = countConfiguredRules(draft.exchangePolicy);
  const validationTone = issues.length > 0 ? "warning" : hasUnsavedChanges ? "neutral" : "success";
  const integrityLabel = hasUnsavedChanges ? "Draft changed" : "Synced";

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">Workspace controls</div>
            <h2 className="hero-card__title">Policy</h2>
            <p className="hero-card__body">
              Manage the hosted secret registry and exchange rules that drive workspace-level request enforcement.
            </p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" onClick={() => void handleRefresh()} type="button">
              <RefreshCw size={16} />
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            {!isReadOnly ? (
              <>
                <button className="ghost-button" disabled={loading || !hasUnsavedChanges} onClick={handleReset} type="button">
                  Reset changes
                </button>
                <button className="ghost-button" disabled={loading || validating} onClick={() => void handleValidate()} type="button">
                  <CheckCircle2 size={16} />
                  {validating ? "Validating..." : "Validate"}
                </button>
                <button
                  className="primary-button"
                  data-testid="save-policy-btn"
                  disabled={loading || saving || !hasUnsavedChanges}
                  onClick={() => void handleSave()}
                  type="button"
                >
                  <Save size={16} />
                  {saving ? "Saving..." : "Save policy"}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>Current version</span>
            <strong>{summaryVersion === 0 ? "Draft" : `v${summaryVersion}`}</strong>
          </article>
          <article className="metric-panel">
            <span>Source</span>
            <strong>{formatSourceLabel(summarySource)}</strong>
          </article>
          <article className="metric-panel">
            <span>Last updated</span>
            <strong>{formatTimestamp(summaryUpdatedAt)}</strong>
          </article>
        </div>
      </div>

      <div className="panel-card policy-action-bar">
        <div>
          <div className="section-label">Registry &amp; Rules</div>
          <h3 className="panel-card__title">Workspace policy editor</h3>
          <p className="panel-card__body">
            {configuredSecrets} registered secrets · {configuredRules} configured rules · {issues.length} active issues
          </p>
        </div>
        <div className="inline-actions">
          <StatusBadge tone={validationTone}>{issues.length > 0 ? "validation issues" : integrityLabel.toLowerCase()}</StatusBadge>
          <StatusBadge tone={isReadOnly ? "warning" : "success"}>{isReadOnly ? "operator view" : "admin editable"}</StatusBadge>
        </div>
      </div>

      {isReadOnly ? (
        <div className="panel-card approvals-viewer-note">
          <ShieldAlert size={18} />
          <div>
            <div className="record-title">Operator access is read-only</div>
            <div className="panel-card__body">
              Operators can inspect workspace policy state and validation output here, but only workspace admins can save changes.
            </div>
          </div>
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="turnstile-placeholder">{success}</div> : null}

      <div className="policy-layout">
        <div className="page-stack">
          <div className="panel-card policy-table-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Secret registry</div>
                <h3 className="panel-card__title">Managed secrets</h3>
                <p className="panel-card__body">Register each secret the workspace can exchange and classify it for policy decisions.</p>
              </div>
              {!isReadOnly ? (
                <button
                  className="ghost-button"
                  data-testid="add-secret-entry-btn"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      secretRegistry: [...current.secretRegistry, emptySecretRegistryEntry()]
                    }))
                  }
                  type="button"
                >
                  <Plus size={16} />
                  Add secret
                </button>
              ) : null}
            </div>

            {loading ? (
              <div className="empty-state">
                <div className="empty-state__eyebrow">Loading</div>
                <h3>Refreshing policy</h3>
                <p>Pulling the current workspace policy document from the hosted API.</p>
              </div>
            ) : (
              <>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Secret name</th>
                      <th>Classification</th>
                      <th>Description</th>
                      {!isReadOnly ? <th aria-label="Actions" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {draft.secretRegistry.map((entry, index) => (
                      <tr key={`secret-${index}`}>
                        <td>
                          <input
                            className="policy-input"
                            disabled={isReadOnly}
                            onChange={(event) => updateRegistryEntry(index, "secretName", event.target.value)}
                            placeholder="stripe.api_key.prod"
                            value={entry.secretName}
                          />
                        </td>
                        <td>
                          <div className="field-stack">
                            <input
                              className="policy-input"
                              disabled={isReadOnly}
                              onChange={(event) => updateRegistryEntry(index, "classification", event.target.value)}
                              placeholder="finance"
                              value={entry.classification}
                            />
                            {entry.classification.trim() ? (
                              <div className="inline-actions">
                                <StatusBadge tone={classificationTone(entry.classification)}>
                                  {entry.classification.trim().toLowerCase()}
                                </StatusBadge>
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <input
                            className="policy-input"
                            disabled={isReadOnly}
                            onChange={(event) => updateRegistryEntry(index, "description", event.target.value)}
                            placeholder="Stripe production key"
                            value={entry.description ?? ""}
                          />
                        </td>
                        {!isReadOnly ? (
                          <td>
                            <button
                              aria-label={`Remove secret ${index + 1}`}
                              className="ghost-button"
                              onClick={() =>
                                setDraft((current) => ({
                                  ...current,
                                  secretRegistry:
                                    current.secretRegistry.length === 1
                                      ? [emptySecretRegistryEntry()]
                                      : current.secretRegistry.filter((_, entryIndex) => entryIndex !== index)
                                }))
                              }
                              type="button"
                            >
                              <Trash2 size={16} />
                              Remove
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="policy-callout">
                  <strong>Secret naming discipline matters.</strong>
                  <span>Use deployment-stable dotted names so policy rules and manifests stay aligned.</span>
                </div>
              </>
            )}
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Exchange rules</div>
                <h3 className="panel-card__title">Rule definitions</h3>
                <p className="panel-card__body">Define requester, fulfiller, ring, and approval controls for each secret exchange path.</p>
              </div>
              {!isReadOnly ? (
                <button
                  className="ghost-button"
                  data-testid="add-rule-btn"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      exchangePolicy: [...current.exchangePolicy, emptyExchangeRule()]
                    }))
                  }
                  type="button"
                >
                  <Plus size={16} />
                  Add rule
                </button>
              ) : null}
            </div>

            <div className="policy-rule-grid">
              {draft.exchangePolicy.map((rule, index) => (
                <article key={`rule-${index}`} className={`approval-card policy-rule-card policy-rule-card--${rule.mode ?? "allow"}`}>
                  <div className="approval-card__header">
                    <div>
                      <div className="section-label">Rule {index + 1}</div>
                      <h3 className="panel-card__title">{rule.ruleId || "Untitled rule"}</h3>
                    </div>
                    <StatusBadge tone={rule.mode === "deny" ? "danger" : rule.mode === "pending_approval" ? "warning" : "success"}>
                      {rule.mode ?? "allow"}
                    </StatusBadge>
                  </div>

                  <div className="policy-rule-summary">
                    <div className="policy-summary-block">
                      <span>Requesters</span>
                      <div className="policy-chip-row">
                        {(rule.requesterIds?.length ? rule.requesterIds : ["Any requester"]).map((value) => (
                          <span key={`${rule.ruleId}-requester-${value}`} className="policy-chip">
                            {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="policy-summary-block">
                      <span>Fulfillers</span>
                      <div className="policy-chip-row">
                        {(rule.fulfillerIds?.length ? rule.fulfillerIds : ["Any fulfiller"]).map((value) => (
                          <span key={`${rule.ruleId}-fulfiller-${value}`} className="policy-chip">
                            {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="policy-summary-block">
                      <span>Purpose / mode</span>
                      <div className="policy-chip-row">
                        {(rule.purposes?.length ? rule.purposes : ["Any purpose"]).map((value) => (
                          <span key={`${rule.ruleId}-purpose-${value}`} className="policy-chip">
                            {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="policy-summary-block">
                      <span>Reason</span>
                      <p className="policy-summary-copy">{rule.reason?.trim() || "No explicit reason set."}</p>
                    </div>
                  </div>

                  <div className="form-grid">
                    <div className="field-stack">
                      <label htmlFor={`rule-id-${index}`}>Rule ID</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-id-${index}`}
                        onChange={(event) => updateRule(index, { ruleId: event.target.value })}
                        placeholder="allow-stripe"
                        value={rule.ruleId}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-secret-${index}`}>Secret name</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-secret-${index}`}
                        onChange={(event) => updateRule(index, { secretName: event.target.value })}
                        placeholder="stripe.api_key.prod"
                        value={rule.secretName}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-mode-${index}`}>Mode</label>
                      <select
                        className="dashboard-select"
                        disabled={isReadOnly}
                        id={`rule-mode-${index}`}
                        onChange={(event) =>
                          updateRule(index, {
                            mode: event.target.value as ExchangePolicyRule["mode"]
                          })
                        }
                        value={rule.mode ?? "allow"}
                      >
                        <option value="allow">allow</option>
                        <option value="pending_approval">pending_approval</option>
                        <option value="deny">deny</option>
                      </select>
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-reason-${index}`}>Reason</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-reason-${index}`}
                        onChange={(event) => updateRule(index, { reason: event.target.value })}
                        placeholder="Primary payments flow"
                        value={rule.reason ?? ""}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-requesters-${index}`}>Requester IDs</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-requesters-${index}`}
                        onChange={(event) => updateRule(index, { requesterIds: parseListInput(event.target.value) })}
                        placeholder="agent:crm-bot, agent:orders-bot"
                        value={toListInput(rule.requesterIds)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-fulfillers-${index}`}>Fulfiller IDs</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-fulfillers-${index}`}
                        onChange={(event) => updateRule(index, { fulfillerIds: parseListInput(event.target.value) })}
                        placeholder="agent:payment-bot"
                        value={toListInput(rule.fulfillerIds)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-approvers-${index}`}>Approver IDs</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-approvers-${index}`}
                        onChange={(event) => updateRule(index, { approverIds: parseListInput(event.target.value) })}
                        placeholder="user:ops-admin"
                        value={toListInput(rule.approverIds)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-purposes-${index}`}>Purposes</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-purposes-${index}`}
                        onChange={(event) => updateRule(index, { purposes: parseListInput(event.target.value) })}
                        placeholder="charge-order, refund-order"
                        value={toListInput(rule.purposes)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-requester-rings-${index}`}>Requester rings</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-requester-rings-${index}`}
                        onChange={(event) => updateRule(index, { requesterRings: parseListInput(event.target.value) })}
                        placeholder="prod, staging"
                        value={toListInput(rule.requesterRings)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-fulfiller-rings-${index}`}>Fulfiller rings</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-fulfiller-rings-${index}`}
                        onChange={(event) => updateRule(index, { fulfillerRings: parseListInput(event.target.value) })}
                        placeholder="prod"
                        value={toListInput(rule.fulfillerRings)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-approver-rings-${index}`}>Approver rings</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-approver-rings-${index}`}
                        onChange={(event) => updateRule(index, { approverRings: parseListInput(event.target.value) })}
                        placeholder="ops"
                        value={toListInput(rule.approverRings)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-allowed-rings-${index}`}>Allowed same-ring list</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-allowed-rings-${index}`}
                        onChange={(event) => updateRule(index, { allowedRings: parseListInput(event.target.value) })}
                        placeholder="prod"
                        value={toListInput(rule.allowedRings)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-approval-reference-${index}`}>Approval reference</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-approval-reference-${index}`}
                        onChange={(event) => updateRule(index, { approvalReference: event.target.value })}
                        placeholder="apr_finance"
                        value={rule.approvalReference ?? ""}
                      />
                    </div>
                  </div>

                  <div className="policy-rule-footer">
                    <label className="policy-checkbox" htmlFor={`rule-same-ring-${index}`}>
                      <input
                        checked={Boolean(rule.sameRing)}
                        disabled={isReadOnly}
                        id={`rule-same-ring-${index}`}
                        onChange={(event) => updateRule(index, { sameRing: event.target.checked })}
                        type="checkbox"
                      />
                      Require same ring
                    </label>

                    {!isReadOnly ? (
                      <button
                        aria-label={`Remove rule ${index + 1}`}
                        className="ghost-button"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            exchangePolicy:
                              current.exchangePolicy.length === 1
                                ? [emptyExchangeRule()]
                                : current.exchangePolicy.filter((_, ruleIndex) => ruleIndex !== index)
                          }))
                        }
                        type="button"
                      >
                        <Trash2 size={16} />
                        Remove rule
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>

        <div className="page-stack">
          <div className="panel-card">
            <div className={`panel-card__header policy-validation-header${issues.length > 0 ? " policy-validation-header--issues" : ""}`}>
              <div>
                <div className="section-label">Validation</div>
                <h3 className="panel-card__title">Draft status {issues.length > 0 ? `(${issues.length})` : ""}</h3>
                <p className="panel-card__body">Run validation before save to surface normalization and policy-contract issues.</p>
              </div>
            </div>

            {issues.length === 0 ? (
              <div className="turnstile-placeholder">
                <CheckCircle2 size={18} />
                <div>
                  <strong>No active validation issues</strong>
                  <span>Run validation after editing to confirm the draft still matches the hosted policy schema.</span>
                </div>
              </div>
            ) : (
              <div className="policy-issue-list">
                {issues.map((issue, index) => (
                  <div
                    key={`${issue.path}-${issue.code}-${index}`}
                    className={`policy-issue ${issue.code === "required" || issue.code.startsWith("invalid") ? "policy-issue--danger" : "policy-issue--warning"}`}
                  >
                    <AlertTriangle className="policy-issue__icon" size={16} />
                    <div>
                      <div className="record-title">{issue.path}</div>
                      <div>{issue.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Hosted metadata</div>
                <h3 className="panel-card__title">Platform-managed details</h3>
                <p className="panel-card__body">Versioning and source history are generated by the hosted control plane.</p>
              </div>
            </div>

            <div className="policy-metadata-list">
              <div className="policy-metadata-row">
                <span>Version</span>
                <strong>{summaryVersion === 0 ? "Draft" : `v${summaryVersion}`}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>Source</span>
                <strong>{formatSourceLabel(summarySource)}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>Updated by</span>
                <strong className="policy-metadata-code">{summaryUpdatedBy}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>Updated at</span>
                <strong>{formatTimestamp(summaryUpdatedAt)}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>Document id</span>
                <strong className="policy-metadata-code">{policy?.id ?? "pending-create"}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>Draft integrity</span>
                <strong>{integrityLabel}</strong>
              </div>
            </div>

            <div className="turnstile-placeholder">
              <FileCode2 size={18} />
              <div>
                <strong>Hosted policy state</strong>
                <span>
                  {policy
                    ? "This workspace now reads policy from the hosted database-backed document."
                    : "No workspace-specific policy exists yet. Saving this draft will create version 1 for the workspace."}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
