import { EmailIntakeQualificationService } from './email-intake-qualification.service';

describe('EmailIntakeQualificationService', () => {
  const makeService = (options?: {
    env?: Record<string, string>;
    classification?: {
      kind:
        | 'showing_request'
        | 'property_question'
        | 'pricing_or_financing'
        | 'objection'
        | 'opt_out'
        | 'auto_reply'
        | 'spam_or_unrelated'
        | 'general_follow_up'
        | 'other';
      confidence: number;
      urgency: 'low' | 'medium' | 'high';
      sentiment: 'positive' | 'neutral' | 'negative';
      language: 'en' | 'fr' | 'other';
      needs_human_reply: boolean;
      reason: string;
      source: 'heuristic' | 'openai';
    };
  }) => {
    const configService = {
      get: jest.fn((key: string) => options?.env?.[key])
    };
    const emailClassifierService = {
      classifyInboundEmail: jest.fn().mockResolvedValue(
        options?.classification ?? {
          kind: 'general_follow_up',
          confidence: 0.6,
          urgency: 'low',
          sentiment: 'neutral',
          language: 'en',
          needs_human_reply: true,
          reason: 'default',
          source: 'heuristic'
        }
      )
    };

    return new EmailIntakeQualificationService(configService as never, emailClassifierService as never);
  };

  it('rejects blocked sender localpart via hard filter', async () => {
    const service = makeService({
      classification: {
        kind: 'general_follow_up',
        confidence: 0.6,
        urgency: 'low',
        sentiment: 'neutral',
        language: 'en',
        needs_human_reply: true,
        reason: 'default',
        source: 'heuristic'
      }
    });

    const result = await service.qualifyInboundEmail({
      fromEmail: 'No-Reply@example.net',
      subject: 'Hello',
      body: 'Interested in scheduling a tour.'
    });

    expect(result.decision).toBe('reject');
    expect(result.score).toBe(0);
    expect(result.reasons.some((reason) => reason.code === 'blocked_localpart')).toBe(true);
  });

  it('maps decision thresholds correctly at 39/40/69/70', () => {
    const service = makeService();

    expect(service.mapDecision(39)).toBe('reject');
    expect(service.mapDecision(40)).toBe('needs_review');
    expect(service.mapDecision(69)).toBe('needs_review');
    expect(service.mapDecision(70)).toBe('create_lead');
  });

  it('classifies strong inbound intent as create_lead', async () => {
    const service = makeService({
      classification: {
        kind: 'showing_request',
        confidence: 0.95,
        urgency: 'high',
        sentiment: 'positive',
        language: 'en',
        needs_human_reply: true,
        reason: 'showing',
        source: 'heuristic'
      }
    });

    const result = await service.qualifyInboundEmail({
      fromEmail: 'buyer@domain.com',
      subject: 'Showing this evening?',
      body: 'Hi, I am very interested in buying this property. Can you schedule a showing tonight?'
    });

    expect(result.decision).toBe('create_lead');
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.reasons.some((reason) => reason.kind === 'threshold')).toBe(true);
  });

  it('routes mid-score inbound to needs_review', async () => {
    const service = makeService({
      classification: {
        kind: 'general_follow_up',
        confidence: 0.5,
        urgency: 'low',
        sentiment: 'neutral',
        language: 'en',
        needs_human_reply: true,
        reason: 'follow up',
        source: 'heuristic'
      }
    });

    const result = await service.qualifyInboundEmail({
      fromEmail: 'person@valid-domain.com',
      body: 'following up'
    });

    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.score).toBeLessThan(70);
    expect(result.decision).toBe('needs_review');
  });

  it('rejects low-score inbound when no hard filter applies', async () => {
    const service = makeService({
      classification: {
        kind: 'objection',
        confidence: 0.3,
        urgency: 'low',
        sentiment: 'negative',
        language: 'en',
        needs_human_reply: true,
        reason: 'objection',
        source: 'heuristic'
      }
    });

    const result = await service.qualifyInboundEmail({
      fromEmail: 'person@valid-domain.com',
      body: 'No'
    });

    expect(result.score).toBeLessThan(40);
    expect(result.decision).toBe('reject');
  });
});
