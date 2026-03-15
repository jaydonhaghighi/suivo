import {
  allowsAutoVoiceCalls,
  allowsManualVoiceCalls,
  computeNextAttemptTime,
  extractVoiceStructuredProfile,
  isVoiceProfileSufficient,
  mergeVoiceProfileFields,
  shouldSuppressAutoVoiceCalls
} from './voice-qualification.utils';

describe('voice-qualification utils', () => {
  it('evaluates sufficient profile correctly', () => {
    const sufficient = {
      intent: 'buy',
      property_type: 'condo',
      budget_min: null,
      budget_max: null,
      budget_approx: 500000,
      location_preferences: ['Griffintown'],
      timeline: '1_3_months',
      mortgage_status: null,
      working_with_agent: null,
      preferred_contact_method: null,
      listing_reference: null
    };

    const insufficient = {
      ...sufficient,
      timeline: null
    };

    expect(isVoiceProfileSufficient(sufficient)).toBe(true);
    expect(isVoiceProfileSufficient(insufficient)).toBe(false);
  });

  it('supports mode switching flags', () => {
    expect(allowsManualVoiceCalls('manual')).toBe(true);
    expect(allowsManualVoiceCalls('both')).toBe(true);
    expect(allowsManualVoiceCalls('auto')).toBe(false);

    expect(allowsAutoVoiceCalls('auto')).toBe(true);
    expect(allowsAutoVoiceCalls('both')).toBe(true);
    expect(allowsAutoVoiceCalls('manual')).toBe(false);
  });

  it('suppresses auto calls for opt-out leads', () => {
    expect(shouldSuppressAutoVoiceCalls({ voice_contact_status: 'opt_out' })).toBe(true);
    expect(shouldSuppressAutoVoiceCalls({ voice_contact_status: 'qualified' })).toBe(false);
    expect(shouldSuppressAutoVoiceCalls(null)).toBe(false);
  });

  it('aligns retry schedule to quiet window in team timezone', () => {
    const base = new Date('2026-03-14T16:50:00.000Z');
    const next = computeNextAttemptTime(base, 0, {
      timeZone: 'America/Toronto',
      callWindowStart: '09:00',
      callWindowEnd: '20:00',
      quietWindowStart: '12:00',
      quietWindowEnd: '13:30'
    });

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Toronto',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    }).format(next);

    expect(parts).toBe('13:30');
  });

  it('extracts gather payload and merges derived profile fields', () => {
    const extracted = extractVoiceStructuredProfile({
      structured_profile: {
        intent: 'buy',
        property_type: 'condo',
        budget_approx: 550000,
        location_preferences: ['Downtown'],
        timeline: '3_6_months'
      }
    });

    const merged = mergeVoiceProfileFields(
      {
        mortgage_status: 'unknown'
      },
      extracted,
      'qualified'
    );

    expect(merged).toMatchObject({
      voice_contact_status: 'qualified',
      intent: 'buy',
      budget_approx: 550000,
      location_preferences: ['Downtown'],
      timeline: '3_6_months',
      mortgage_status: 'unknown'
    });
  });
});
