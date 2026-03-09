import { EmailClassifierService } from './email-classifier.service';

describe('EmailClassifierService', () => {
  const makeService = () => {
    const configService = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'OPENAI_MODEL') {
          return fallback;
        }
        return undefined;
      })
    };

    return new EmailClassifierService(configService as never);
  };

  it('classifies opt-out language with high confidence', async () => {
    const service = makeService();

    const result = await service.classifyInboundEmail({
      fromEmail: 'lead@example.com',
      subject: 'Please remove me',
      body: 'Unsubscribe and do not contact me again'
    });

    expect(result.kind).toBe('opt_out');
    expect(result.urgency).toBe('high');
    expect(result.needs_human_reply).toBe(true);
    expect(result.source).toBe('heuristic');
  });

  it('classifies auto-reply and marks no human reply needed', async () => {
    const service = makeService();

    const result = await service.classifyInboundEmail({
      fromEmail: 'lead@example.com',
      subject: 'Automatic reply',
      body: 'I am currently out of office and will return next week.'
    });

    expect(result.kind).toBe('auto_reply');
    expect(result.needs_human_reply).toBe(false);
  });
});
