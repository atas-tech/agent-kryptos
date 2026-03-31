import { AlertTriangle, CheckCircle2, FileCode2, Plus, RefreshCw, Save, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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

function formatTimestamp(value: string | null | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  return dateFormatter.format(new Date(value));
}

function countConfiguredSecrets(entries: SecretRegistryEntry[]): number {
  return entries.filter((entry) => entry.secretName.trim() || entry.classification.trim() || entry.description?.trim()).length;
}

function countConfiguredRules(rules: ExchangePolicyRule[]): number {
  return rules.filter((rule) => rule.ruleId.trim() || rule.secretName.trim() || (rule.purposes?.length ?? 0) > 0).length;
}

function formatSourceLabel(source: string, t: (key: string) => string): string {
  switch (source) {
    case "draft":
      return t("policy:metadata.sourceDraft");
    case "manual":
      return t("policy:metadata.sourceManual");
    default:
      return source.replaceAll("_", " ");
  }
}

function formatModeLabel(mode: ExchangePolicyRule["mode"] | undefined, t: (key: string) => string): string {
  switch (mode) {
    case "pending_approval":
      return t("policy:rules.modePendingApproval");
    case "deny":
      return t("policy:rules.modeDeny");
    case "allow":
    default:
      return t("policy:rules.modeAllow");
  }
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
  const { t } = useTranslation(["policy", "common"]);
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

      setError(requestError instanceof Error ? requestError.message : t("policy:errors.loadFailed"));
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
      setSuccess(payload.valid ? t("policy:validation.passed") : t("policy:validation.hasIssues"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("policy:errors.validateFailed"));
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
      setSuccess(t("policy:success.saved", { version: payload.policy.version }));
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === "workspace_policy_invalid") {
        const invalidIssues = Array.isArray(requestError.issues) ? (requestError.issues as WorkspacePolicyValidationIssue[]) : [];
        setIssues(invalidIssues);
      }

      setError(requestError instanceof Error ? requestError.message : t("policy:errors.saveFailed"));
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
  const summaryUpdatedBy = policy?.updated_by_user_id ?? t("policy:metadata.platformBootstrap");
  const configuredSecrets = countConfiguredSecrets(draft.secretRegistry);
  const configuredRules = countConfiguredRules(draft.exchangePolicy);
  const validationTone = issues.length > 0 ? "warning" : hasUnsavedChanges ? "neutral" : "success";
  const integrityLabel = hasUnsavedChanges ? t("policy:status.draftChanged") : t("policy:status.synced");

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">{t("policy:hero.sectionLabel")}</div>
            <h2 className="hero-card__title">{t("policy:hero.title")}</h2>
            <p className="hero-card__body">{t("policy:hero.body")}</p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" onClick={() => void handleRefresh()} type="button">
              <RefreshCw size={16} />
              {refreshing ? t("policy:actions.refreshing") : t("policy:actions.refresh")}
            </button>
            {!isReadOnly ? (
              <>
                <button className="ghost-button" disabled={loading || !hasUnsavedChanges} onClick={handleReset} type="button">
                  {t("policy:actions.resetChanges")}
                </button>
                <button className="ghost-button" data-testid="validate-policy-btn" disabled={loading || validating} onClick={() => void handleValidate()} type="button">
                  <CheckCircle2 size={16} />
                  {validating ? t("policy:actions.validating") : t("policy:actions.validate")}
                </button>
                <button
                  className="primary-button"
                  data-testid="save-policy-btn"
                  disabled={loading || saving || !hasUnsavedChanges || issues.length > 0}
                  onClick={() => void handleSave()}
                  type="button"
                >
                  <Save size={16} />
                  {saving ? t("policy:actions.saving") : t("policy:actions.savePolicy")}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>{t("policy:stats.currentVersion")}</span>
            <strong>{summaryVersion === 0 ? t("policy:stats.draft") : `v${summaryVersion}`}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("policy:stats.source")}</span>
            <strong>{formatSourceLabel(summarySource, t)}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("policy:stats.lastUpdated")}</span>
            <strong>{formatTimestamp(summaryUpdatedAt, t("policy:stats.notAvailable"))}</strong>
          </article>
        </div>
      </div>

      <div className="panel-card policy-action-bar">
        <div>
          <div className="section-label">{t("policy:status.sectionLabel")}</div>
          <h3 className="panel-card__title">{t("policy:status.title")}</h3>
          <p className="panel-card__body">
            {t("policy:status.summary", {
              secrets: configuredSecrets,
              rules: configuredRules,
              issues: issues.length
            })}
          </p>
        </div>
        <div className="inline-actions">
          <StatusBadge tone={validationTone}>{issues.length > 0 ? t("policy:status.validationIssues") : integrityLabel}</StatusBadge>
          <StatusBadge tone={isReadOnly ? "warning" : "success"}>
            {isReadOnly ? t("policy:status.operatorView") : t("policy:status.adminEditable")}
          </StatusBadge>
        </div>
      </div>

      {isReadOnly ? (
        <div className="panel-card approvals-viewer-note">
          <ShieldAlert size={18} />
          <div>
            <div className="record-title">{t("policy:readOnly.title")}</div>
            <div className="panel-card__body">{t("policy:readOnly.body")}</div>
          </div>
        </div>
      ) : null}

      {error ? <div className="error-banner" data-testid="policy-error-banner">{error}</div> : null}
      {success ? <div className="policy-success-banner" data-testid="policy-status-message">{success}</div> : null}

      <div className="policy-layout">
        <div className="page-stack">
          <div className="panel-card policy-table-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("policy:registry.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("policy:registry.title")}</h3>
                <p className="panel-card__body">{t("policy:registry.body")}</p>
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
                  {t("policy:registry.addSecret")}
                </button>
              ) : null}
            </div>

            {loading ? (
              <div className="empty-state">
                <div className="empty-state__eyebrow">{t("common:loading")}</div>
                <h3>{t("policy:registry.loadingTitle")}</h3>
                <p>{t("policy:registry.loadingBody")}</p>
              </div>
            ) : (
              <>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("policy:registry.columnName")}</th>
                      <th>{t("policy:registry.columnClassification")}</th>
                      <th>{t("policy:registry.columnDescription")}</th>
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
                            placeholder={t("policy:registry.namePlaceholder")}
                            value={entry.secretName}
                          />
                        </td>
                        <td>
                          <div className="field-stack">
                            <input
                              className="policy-input"
                              disabled={isReadOnly}
                              onChange={(event) => updateRegistryEntry(index, "classification", event.target.value)}
                              placeholder={t("policy:registry.classificationPlaceholder")}
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
                            placeholder={t("policy:registry.descriptionPlaceholder")}
                            value={entry.description ?? ""}
                          />
                        </td>
                        {!isReadOnly ? (
                          <td>
                            <button
                              aria-label={t("policy:registry.removeSecretLabel", { index: index + 1 })}
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
                              {t("policy:registry.removeSecret")}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="policy-callout">
                  <strong>{t("policy:registry.namingCallout")}</strong>
                  <span>{t("policy:registry.namingHint")}</span>
                </div>
              </>
            )}
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("policy:rules.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("policy:rules.title")}</h3>
                <p className="panel-card__body">{t("policy:rules.body")}</p>
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
                  {t("policy:rules.addRule")}
                </button>
              ) : null}
            </div>

            <div className="policy-rule-grid">
              {draft.exchangePolicy.map((rule, index) => (
                <article key={`rule-${index}`} className={`approval-card policy-rule-card policy-rule-card--${rule.mode ?? "allow"}`} data-testid="policy-rule-card">
                  <div className="approval-card__header">
                    <div>
                      <div className="section-label">{t("policy:rules.ruleLabel", { index: index + 1 })}</div>
                      <h3 className="panel-card__title">{rule.ruleId || t("policy:rules.untitledRule")}</h3>
                    </div>
                    <StatusBadge tone={rule.mode === "deny" ? "danger" : rule.mode === "pending_approval" ? "warning" : "success"}>
                      {formatModeLabel(rule.mode, t)}
                    </StatusBadge>
                  </div>

                  <div className="policy-rule-summary">
                    <div className="policy-summary-block">
                      <span>{t("policy:rules.requesters")}</span>
                      <div className="policy-chip-row">
                        {(rule.requesterIds?.length ? rule.requesterIds : [t("policy:rules.anyRequester")]).map((value) => (
                          <span key={`${rule.ruleId}-requester-${value}`} className="policy-chip">
                            {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="policy-summary-block">
                      <span>{t("policy:rules.fulfillers")}</span>
                      <div className="policy-chip-row">
                        {(rule.fulfillerIds?.length ? rule.fulfillerIds : [t("policy:rules.anyFulfiller")]).map((value) => (
                          <span key={`${rule.ruleId}-fulfiller-${value}`} className="policy-chip">
                            {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="policy-summary-block">
                      <span>{t("policy:rules.purposeMode")}</span>
                      <div className="policy-chip-row">
                        {(rule.purposes?.length ? rule.purposes : [t("policy:rules.anyPurpose")]).map((value) => (
                          <span key={`${rule.ruleId}-purpose-${value}`} className="policy-chip">
                            {value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="policy-summary-block">
                      <span>{t("policy:rules.reason")}</span>
                      <p className="policy-summary-copy">{rule.reason?.trim() || t("policy:rules.noReason")}</p>
                    </div>
                  </div>

                  <div className="form-grid">
                    <div className="field-stack">
                      <label htmlFor={`rule-id-${index}`}>{t("policy:rules.ruleId")}</label>
                      <input
                        className="policy-input"
                        data-testid="rule-id-input"
                        disabled={isReadOnly}
                        id={`rule-id-${index}`}
                        onChange={(event) => updateRule(index, { ruleId: event.target.value })}
                        placeholder={t("policy:rules.ruleIdPlaceholder")}
                        value={rule.ruleId}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-secret-${index}`}>{t("policy:rules.secretName")}</label>
                      <input
                        className="policy-input"
                        data-testid="rule-secret-input"
                        disabled={isReadOnly}
                        id={`rule-secret-${index}`}
                        onChange={(event) => updateRule(index, { secretName: event.target.value })}
                        placeholder={t("policy:rules.secretNamePlaceholder")}
                        value={rule.secretName}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-mode-${index}`}>{t("policy:rules.mode")}</label>
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
                        <option value="allow">{t("policy:rules.modeAllow")}</option>
                        <option value="pending_approval">{t("policy:rules.modePendingApproval")}</option>
                        <option value="deny">{t("policy:rules.modeDeny")}</option>
                      </select>
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-reason-${index}`}>{t("policy:rules.reason")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-reason-${index}`}
                        onChange={(event) => updateRule(index, { reason: event.target.value })}
                        placeholder={t("policy:rules.reasonPlaceholder")}
                        value={rule.reason ?? ""}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-requesters-${index}`}>{t("policy:rules.requesterIds")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-requesters-${index}`}
                        onChange={(event) => updateRule(index, { requesterIds: parseListInput(event.target.value) })}
                        placeholder={t("policy:rules.requesterIdsPlaceholder")}
                        value={toListInput(rule.requesterIds)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-fulfillers-${index}`}>{t("policy:rules.fulfillerIds")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-fulfillers-${index}`}
                        onChange={(event) => updateRule(index, { fulfillerIds: parseListInput(event.target.value) })}
                        placeholder={t("policy:rules.fulfillerIdsPlaceholder")}
                        value={toListInput(rule.fulfillerIds)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-approvers-${index}`}>{t("policy:rules.approverIds")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-approvers-${index}`}
                        onChange={(event) => updateRule(index, { approverIds: parseListInput(event.target.value) })}
                        placeholder={t("policy:rules.approverIdsPlaceholder")}
                        value={toListInput(rule.approverIds)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-purposes-${index}`}>{t("policy:rules.purposes")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-purposes-${index}`}
                        onChange={(event) => updateRule(index, { purposes: parseListInput(event.target.value) })}
                        placeholder={t("policy:rules.purposesPlaceholder")}
                        value={toListInput(rule.purposes)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-requester-rings-${index}`}>{t("policy:rules.requesterRings")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-requester-rings-${index}`}
                        onChange={(event) => updateRule(index, { requesterRings: parseListInput(event.target.value) })}
                        placeholder={t("policy:rules.requesterRingsPlaceholder")}
                        value={toListInput(rule.requesterRings)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-fulfiller-rings-${index}`}>{t("policy:rules.fulfillerRings")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-fulfiller-rings-${index}`}
                        onChange={(event) => updateRule(index, { fulfillerRings: parseListInput(event.target.value) })}
                        placeholder={t("policy:rules.fulfillerRingsPlaceholder")}
                        value={toListInput(rule.fulfillerRings)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-approver-rings-${index}`}>{t("policy:rules.approverRings")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-approver-rings-${index}`}
                        onChange={(event) => updateRule(index, { approverRings: parseListInput(event.target.value) })}
                        placeholder={t("policy:rules.approverRingsPlaceholder")}
                        value={toListInput(rule.approverRings)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-allowed-rings-${index}`}>{t("policy:rules.allowedRings")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-allowed-rings-${index}`}
                        onChange={(event) => updateRule(index, { allowedRings: parseListInput(event.target.value) })}
                        placeholder={t("policy:rules.allowedRingsPlaceholder")}
                        value={toListInput(rule.allowedRings)}
                      />
                    </div>
                    <div className="field-stack">
                      <label htmlFor={`rule-approval-reference-${index}`}>{t("policy:rules.approvalReference")}</label>
                      <input
                        className="policy-input"
                        disabled={isReadOnly}
                        id={`rule-approval-reference-${index}`}
                        onChange={(event) => updateRule(index, { approvalReference: event.target.value })}
                        placeholder={t("policy:rules.approvalReferencePlaceholder")}
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
                      {t("policy:rules.sameRing")}
                    </label>

                    {!isReadOnly ? (
                      <button
                        aria-label={t("policy:rules.removeRuleLabel", { index: index + 1 })}
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
                        {t("policy:rules.removeRule")}
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
                <div className="section-label">{t("policy:validation.sectionLabel")}</div>
                <h3 className="panel-card__title">
                  {issues.length > 0
                    ? t("policy:validation.titleWithIssues", { count: issues.length })
                    : t("policy:validation.title")}
                </h3>
                <p className="panel-card__body">{t("policy:validation.body")}</p>
              </div>
            </div>

            {issues.length === 0 ? (
              <div className="turnstile-placeholder">
                <CheckCircle2 size={18} />
                <div>
                  <strong>{t("policy:validation.noIssues")}</strong>
                  <span>{t("policy:validation.noIssuesHint")}</span>
                </div>
              </div>
            ) : (
              <div className="policy-issue-list" data-testid="policy-issue-list">
                {issues.map((issue, index) => (
                  <div
                    key={`${issue.path}-${issue.code}-${index}`}
                    className={`policy-issue ${issue.code === "required" || issue.code.startsWith("invalid") ? "policy-issue--danger" : "policy-issue--warning"}`}
                  >
                    <AlertTriangle className="policy-issue__icon" size={16} />
                    <div>
                      <div className="record-title">{issue.path}</div>
                      <div data-testid="policy-issue-message">{issue.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("policy:metadata.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("policy:metadata.title")}</h3>
                <p className="panel-card__body">{t("policy:metadata.body")}</p>
              </div>
            </div>

            <div className="policy-metadata-list">
              <div className="policy-metadata-row">
                <span>{t("policy:metadata.version")}</span>
                <strong>{summaryVersion === 0 ? t("policy:stats.draft") : `v${summaryVersion}`}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>{t("policy:metadata.source")}</span>
                <strong>{formatSourceLabel(summarySource, t)}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>{t("policy:metadata.updatedBy")}</span>
                <strong className="policy-metadata-code">{summaryUpdatedBy}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>{t("policy:metadata.updatedAt")}</span>
                <strong>{formatTimestamp(summaryUpdatedAt, t("policy:stats.notAvailable"))}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>{t("policy:metadata.documentId")}</span>
                <strong className="policy-metadata-code">{policy?.id ?? t("policy:metadata.pendingCreate")}</strong>
              </div>
              <div className="policy-metadata-row">
                <span>{t("policy:metadata.draftIntegrity")}</span>
                <strong>{integrityLabel}</strong>
              </div>
            </div>

            <div className="turnstile-placeholder">
              <FileCode2 size={18} />
              <div>
                <strong>{t("policy:metadata.hostedStateTitle")}</strong>
                <span>
                  {policy
                    ? t("policy:metadata.hostedStateExisting")
                    : t("policy:metadata.hostedStateNew")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
