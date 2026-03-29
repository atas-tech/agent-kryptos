export type JsonValue = string | number | boolean | null | JsonObj | JsonValue[];
export type JsonObj = { [key: string]: JsonValue };

const IDENTICAL_STRING_COUNT_THRESHOLD = 5;
const IDENTICAL_STRING_RATIO_THRESHOLD = 0.35;

export interface TranslationDriftResult {
  comparableStrings: number;
  identicalKeys: string[];
  identicalRatio: number;
  suspicious: boolean;
}

export interface TranslationDriftOptions {
  ignoredKeys?: ReadonlySet<string>;
}

export function collectKeys(obj: JsonObj, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys.push(...collectKeys(value as JsonObj, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

export function collectStringEntries(obj: JsonObj, prefix = ""): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      entries.push(...collectStringEntries(value as JsonObj, fullKey));
      continue;
    }

    if (typeof value === "string") {
      entries.push([fullKey, value]);
    }
  }

  return entries.sort(([left], [right]) => left.localeCompare(right));
}

function normalizeString(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isPotentiallyTranslatableString(value: string): boolean {
  const normalized = normalizeString(value);
  if (!normalized) {
    return false;
  }

  if (!/[A-Za-z]/.test(normalized)) {
    return false;
  }

  if (/^(https?:\/\/|mailto:)/i.test(normalized)) {
    return false;
  }

  if (/^[A-Z0-9_.:/{} -]+$/.test(normalized)) {
    return false;
  }

  if (/^[a-z0-9_.:/@-]+$/.test(normalized) && !normalized.includes(" ")) {
    return false;
  }

  return true;
}

export function analyzeTranslationDrift(
  reference: JsonObj,
  target: JsonObj,
  options: TranslationDriftOptions = {}
): TranslationDriftResult {
  const referenceEntries = new Map(collectStringEntries(reference));
  const targetEntries = new Map(collectStringEntries(target));
  const identicalKeys: string[] = [];
  let comparableStrings = 0;

  for (const [key, referenceValue] of referenceEntries) {
    if (options.ignoredKeys?.has(key)) {
      continue;
    }

    const targetValue = targetEntries.get(key);
    if (typeof targetValue !== "string") {
      continue;
    }

    if (!isPotentiallyTranslatableString(referenceValue)) {
      continue;
    }

    comparableStrings += 1;
    if (normalizeString(referenceValue) === normalizeString(targetValue)) {
      identicalKeys.push(key);
    }
  }

  const identicalRatio = comparableStrings === 0 ? 0 : identicalKeys.length / comparableStrings;
  const suspicious =
    identicalKeys.length >= IDENTICAL_STRING_COUNT_THRESHOLD &&
    identicalRatio >= IDENTICAL_STRING_RATIO_THRESHOLD;

  return {
    comparableStrings,
    identicalKeys,
    identicalRatio,
    suspicious
  };
}
