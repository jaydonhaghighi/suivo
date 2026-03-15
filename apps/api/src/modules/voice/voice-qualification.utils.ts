import { voiceQualificationRuleSchema } from '@mvp/shared-types';

export type VoiceTriggerMode = 'manual' | 'auto' | 'both';

export interface VoiceStructuredProfile {
  intent: string | null;
  property_type: string | null;
  budget_min: number | null;
  budget_max: number | null;
  budget_approx: number | null;
  location_preferences: string[];
  timeline: string | null;
  mortgage_status: string | null;
  working_with_agent: string | null;
  preferred_contact_method: string | null;
  listing_reference: string | null;
}

export interface VoiceQualificationResult {
  qualification_status: 'qualified' | 'partial' | 'unreachable' | 'opt_out' | 'escalated' | 'not_interested';
  structured_profile: VoiceStructuredProfile;
  summary: string;
  recommended_next_action: 'send_listings' | 'book_showing' | 'callback' | 'transfer_to_agent' | 'nurture' | 'none';
  transcript_status: 'complete' | 'partial' | 'unavailable';
}

export interface CallWindowConfig {
  timeZone: string;
  callWindowStart: string;
  callWindowEnd: string;
  quietWindowStart: string;
  quietWindowEnd: string;
}

const hhmmRegex = /^(\d{2}):(\d{2})$/;

export function parseMinutesOfDay(value: string): number {
  const match = value.match(hhmmRegex);
  if (!match) {
    throw new Error(`Invalid time value: ${value}`);
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time value: ${value}`);
  }

  return hours * 60 + minutes;
}

export function normalizeE164(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const stripped = trimmed.replace(/[\s()\-.]/g, '');
  if (!/^\+?\d{10,15}$/.test(stripped)) {
    return null;
  }

  return stripped.startsWith('+') ? stripped : `+${stripped}`;
}

export function allowsManualVoiceCalls(mode: VoiceTriggerMode): boolean {
  return mode === 'manual' || mode === 'both';
}

export function allowsAutoVoiceCalls(mode: VoiceTriggerMode): boolean {
  return mode === 'auto' || mode === 'both';
}

export function buildDefaultVoiceQualificationRules(): ReturnType<typeof voiceQualificationRuleSchema.parse> {
  return voiceQualificationRuleSchema.parse({});
}

function getObject(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function getString(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const normalized = input.trim();
  return normalized.length > 0 ? normalized : null;
}

function getNumber(input: unknown): number | null {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === 'string') {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number.parseFloat(normalized.replace(/[$,]/g, ''));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function getOptionalStringArray(input: unknown): string[] | null {
  if (!Array.isArray(input)) {
    return null;
  }

  const values = input
    .map((item) => getString(item))
    .filter((item): item is string => Boolean(item));

  return values.length ? values : null;
}

function firstDefined<T>(...candidates: Array<T | null | undefined>): T | null {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) {
      return candidate;
    }
  }
  return null;
}

export function extractVoiceStructuredProfile(payload: unknown): VoiceStructuredProfile {
  const root = getObject(payload) ?? {};
  const structured = getObject(root.structured_profile) ?? {};
  const qualification = getObject(root.qualification) ?? {};
  const memoryUpdates = getObject(root.memory_updates) ?? {};

  const budget = getObject(structured.budget) ?? getObject(qualification.budget) ?? {};

  return {
    intent: firstDefined(getString(structured.intent), getString(qualification.intent), getString(memoryUpdates.intent)),
    property_type: firstDefined(
      getString(structured.property_type),
      getString(qualification.property_type),
      getString(memoryUpdates.property_type)
    ),
    budget_min: firstDefined(
      getNumber(structured.budget_min),
      getNumber(qualification.budget_min),
      getNumber(memoryUpdates.budget_min),
      getNumber(budget.min)
    ),
    budget_max: firstDefined(
      getNumber(structured.budget_max),
      getNumber(qualification.budget_max),
      getNumber(memoryUpdates.budget_max),
      getNumber(budget.max)
    ),
    budget_approx: firstDefined(
      getNumber(structured.budget_approx),
      getNumber(qualification.budget_approx),
      getNumber(memoryUpdates.budget_approx),
      getNumber(budget.approx)
    ),
    location_preferences: firstDefined<string[]>(
      getOptionalStringArray(structured.location_preferences),
      getOptionalStringArray(qualification.location_preferences),
      getOptionalStringArray(memoryUpdates.location_preferences)
    ) ?? [],
    timeline: firstDefined(getString(structured.timeline), getString(qualification.timeline), getString(memoryUpdates.timeline)),
    mortgage_status: firstDefined(
      getString(structured.mortgage_status),
      getString(qualification.mortgage_status),
      getString(memoryUpdates.mortgage_status)
    ),
    working_with_agent: firstDefined(
      getString(structured.working_with_agent),
      getString(qualification.working_with_agent),
      getString(memoryUpdates.working_with_agent)
    ),
    preferred_contact_method: firstDefined(
      getString(structured.preferred_contact_method),
      getString(qualification.preferred_contact_method),
      getString(memoryUpdates.preferred_contact_method)
    ),
    listing_reference: firstDefined(
      getString(structured.listing_reference),
      getString(qualification.listing_reference),
      getString(memoryUpdates.listing_reference)
    )
  };
}

function hasNumericBudget(profile: VoiceStructuredProfile): boolean {
  return profile.budget_approx !== null || profile.budget_min !== null || profile.budget_max !== null;
}

function hasLocation(profile: VoiceStructuredProfile): boolean {
  return profile.location_preferences.length > 0 || profile.listing_reference !== null;
}

function hasMeaningfulValue(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'unknown' && normalized !== 'unspecified';
}

export function isVoiceProfileSufficient(profile: VoiceStructuredProfile): boolean {
  const hasIntent = hasMeaningfulValue(profile.intent);
  const hasPropertyOrBudget = hasMeaningfulValue(profile.property_type) || hasNumericBudget(profile);
  const hasTimeline = hasMeaningfulValue(profile.timeline);

  return hasIntent && hasPropertyOrBudget && hasLocation(profile) && hasTimeline;
}

export function mergeVoiceProfileFields(
  existing: Record<string, unknown> | null,
  profile: VoiceStructuredProfile,
  status: string
): Record<string, unknown> {
  const base = existing ?? {};
  const next: Record<string, unknown> = {
    ...base,
    voice_contact_status: status
  };

  const assignIfPresent = (key: keyof VoiceStructuredProfile): void => {
    const value = profile[key];
    if (value === null) {
      return;
    }
    if (Array.isArray(value) && value.length === 0) {
      return;
    }
    next[key] = value;
  };

  assignIfPresent('intent');
  assignIfPresent('property_type');
  assignIfPresent('budget_min');
  assignIfPresent('budget_max');
  assignIfPresent('budget_approx');
  assignIfPresent('location_preferences');
  assignIfPresent('timeline');
  assignIfPresent('mortgage_status');
  assignIfPresent('working_with_agent');
  assignIfPresent('preferred_contact_method');
  assignIfPresent('listing_reference');

  return next;
}

interface TimeZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function toTimeZoneParts(date: Date, timeZone: string): TimeZoneParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const rawParts = formatter.formatToParts(date);
  const mapped: Record<string, string> = {};
  for (const part of rawParts) {
    if (part.type !== 'literal') {
      mapped[part.type] = part.value;
    }
  }

  return {
    year: Number.parseInt(mapped.year ?? '0', 10),
    month: Number.parseInt(mapped.month ?? '1', 10),
    day: Number.parseInt(mapped.day ?? '1', 10),
    hour: Number.parseInt(mapped.hour ?? '0', 10),
    minute: Number.parseInt(mapped.minute ?? '0', 10),
    second: Number.parseInt(mapped.second ?? '0', 10)
  };
}

function localDateTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date {
  let utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let index = 0; index < 5; index += 1) {
    const candidate = new Date(utcMillis);
    const candidateParts = toTimeZoneParts(candidate, timeZone);

    const desiredMillis = Date.UTC(year, month - 1, day, hour, minute, second);
    const candidateLocalMillis = Date.UTC(
      candidateParts.year,
      candidateParts.month - 1,
      candidateParts.day,
      candidateParts.hour,
      candidateParts.minute,
      candidateParts.second
    );

    const correction = desiredMillis - candidateLocalMillis;
    if (correction === 0) {
      break;
    }

    utcMillis += correction;
  }

  return new Date(utcMillis);
}

function addDays(year: number, month: number, day: number, amount: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

export function alignToCallWindow(referenceTime: Date, config: CallWindowConfig): Date {
  const callWindowStart = parseMinutesOfDay(config.callWindowStart);
  const callWindowEnd = parseMinutesOfDay(config.callWindowEnd);
  const quietWindowStart = parseMinutesOfDay(config.quietWindowStart);
  const quietWindowEnd = parseMinutesOfDay(config.quietWindowEnd);

  let cursor = new Date(referenceTime.getTime());

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const local = toTimeZoneParts(cursor, config.timeZone);
    const localMinutes = local.hour * 60 + local.minute;

    if (localMinutes < callWindowStart) {
      return localDateTimeToUtc(
        config.timeZone,
        local.year,
        local.month,
        local.day,
        Math.floor(callWindowStart / 60),
        callWindowStart % 60,
        0
      );
    }

    if (localMinutes >= callWindowEnd) {
      const nextDay = addDays(local.year, local.month, local.day, 1);
      return localDateTimeToUtc(
        config.timeZone,
        nextDay.year,
        nextDay.month,
        nextDay.day,
        Math.floor(callWindowStart / 60),
        callWindowStart % 60,
        0
      );
    }

    if (localMinutes >= quietWindowStart && localMinutes < quietWindowEnd) {
      return localDateTimeToUtc(
        config.timeZone,
        local.year,
        local.month,
        local.day,
        Math.floor(quietWindowEnd / 60),
        quietWindowEnd % 60,
        0
      );
    }

    return cursor;
  }

  return cursor;
}

export function computeNextAttemptTime(
  now: Date,
  retryOffsetMinutes: number,
  config: CallWindowConfig
): Date {
  const candidate = new Date(now.getTime() + retryOffsetMinutes * 60_000);
  return alignToCallWindow(candidate, config);
}

export function shouldSuppressAutoVoiceCalls(fields: Record<string, unknown> | null): boolean {
  const status = typeof fields?.voice_contact_status === 'string' ? fields.voice_contact_status.toLowerCase() : '';
  return status === 'opt_out';
}

export function pickQualificationStatus(profile: VoiceStructuredProfile): 'qualified' | 'partial' {
  if (isVoiceProfileSufficient(profile)) {
    return 'qualified';
  }
  return 'partial';
}
