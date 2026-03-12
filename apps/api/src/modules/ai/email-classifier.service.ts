import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { z } from 'zod';

const classificationKindSchema = z.enum([
  'showing_request',
  'property_question',
  'pricing_or_financing',
  'objection',
  'opt_out',
  'auto_reply',
  'spam_or_unrelated',
  'general_follow_up',
  'other'
]);

const classificationSchema = z.object({
  kind: classificationKindSchema,
  confidence: z.number().min(0).max(1),
  urgency: z.enum(['low', 'medium', 'high']),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  language: z.enum(['en', 'fr', 'other']),
  needs_human_reply: z.boolean(),
  reason: z.string().min(1).max(240),
  source: z.enum(['heuristic', 'openai'])
});

type EmailClassification = z.infer<typeof classificationSchema>;

interface InboundEmailClassificationInput {
  subject?: string | undefined;
  body?: string | undefined;
  fromEmail: string;
}

@Injectable()
export class EmailClassifierService {
  private readonly logger = new Logger(EmailClassifierService.name);
  private readonly client?: OpenAI;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.model = this.configService.get<string>('OPENAI_MODEL', 'gpt-4o-mini');
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  async classifyInboundEmail(input: InboundEmailClassificationInput): Promise<EmailClassification> {
    const subject = (input.subject ?? '').trim();
    const body = (input.body ?? '').trim();
    const fallback = this.classifyWithHeuristics(subject, body);
    if (!this.client || (!subject && !body)) {
      return fallback;
    }

    const prompt = [
      'Classify this inbound real-estate client email.',
      'Return JSON only with keys: kind, confidence, urgency, sentiment, language, needs_human_reply, reason.',
      `Allowed kind values: ${classificationKindSchema.options.join(', ')}`,
      'Allowed urgency: low, medium, high.',
      'Allowed sentiment: positive, neutral, negative.',
      'Allowed language: en, fr, other.',
      'confidence must be 0 to 1.',
      `From: ${input.fromEmail}`,
      `Subject: ${subject || '(empty)'}`,
      `Body: ${body || '(empty)'}`
    ].join('\n');

    try {
      const response = await this.client.responses.create({
        model: this.model,
        temperature: 0,
        input: [
          {
            role: 'system',
            content: 'You are a strict email classifier. Return valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const parsed = this.parseModelJson(response.output_text ?? '');
      if (!parsed) {
        return fallback;
      }

      const validated = classificationSchema
        .omit({ source: true })
        .safeParse(parsed);
      if (!validated.success) {
        return fallback;
      }

      return {
        ...validated.data,
        source: 'openai'
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`OpenAI classification failed, using heuristics: ${message}`);
      return fallback;
    }
  }

  private classifyWithHeuristics(subject: string, body: string): EmailClassification {
    const text = `${subject}\n${body}`.toLowerCase();
    const language = this.detectLanguage(text);

    if (this.includesAny(text, ['automatic reply', 'auto-reply', 'out of office', 'vacation responder'])) {
      return {
        kind: 'auto_reply',
        confidence: 0.98,
        urgency: 'low',
        sentiment: 'neutral',
        language,
        needs_human_reply: false,
        reason: 'Automatic response indicators detected.',
        source: 'heuristic'
      };
    }

    if (this.includesAny(text, ['unsubscribe', 'stop', 'do not contact', 'remove me', 'dont contact'])) {
      return {
        kind: 'opt_out',
        confidence: 0.99,
        urgency: 'high',
        sentiment: 'negative',
        language,
        needs_human_reply: true,
        reason: 'Opt-out or do-not-contact language detected.',
        source: 'heuristic'
      };
    }

    if (this.includesAny(text, ['winner', 'bitcoin', 'crypto', 'wire transfer', 'gift card'])) {
      return {
        kind: 'spam_or_unrelated',
        confidence: 0.9,
        urgency: 'low',
        sentiment: 'neutral',
        language,
        needs_human_reply: false,
        reason: 'Likely spam or unrelated email pattern detected.',
        source: 'heuristic'
      };
    }

    if (this.includesAny(text, ['tour', 'showing', 'visit', 'appointment', 'available this'])) {
      return {
        kind: 'showing_request',
        confidence: 0.84,
        urgency: this.includesAny(text, ['today', 'tonight', 'asap', 'urgent']) ? 'high' : 'medium',
        sentiment: this.detectSentiment(text),
        language,
        needs_human_reply: true,
        reason: 'Scheduling or showing intent detected.',
        source: 'heuristic'
      };
    }

    if (this.includesAny(text, ['price', 'budget', 'mortgage', 'rate', 'down payment', 'financing', 'pre-approval'])) {
      return {
        kind: 'pricing_or_financing',
        confidence: 0.8,
        urgency: this.includesAny(text, ['urgent', 'asap']) ? 'high' : 'medium',
        sentiment: this.detectSentiment(text),
        language,
        needs_human_reply: true,
        reason: 'Pricing or financing topic detected.',
        source: 'heuristic'
      };
    }

    if (this.includesAny(text, ['not interested', 'too expensive', 'already bought', 'no longer looking'])) {
      return {
        kind: 'objection',
        confidence: 0.83,
        urgency: 'medium',
        sentiment: 'negative',
        language,
        needs_human_reply: true,
        reason: 'Objection or disinterest language detected.',
        source: 'heuristic'
      };
    }

    if (text.includes('?') || this.includesAny(text, ['can you', 'could you', 'what', 'when', 'where', 'how'])) {
      return {
        kind: 'property_question',
        confidence: 0.72,
        urgency: 'medium',
        sentiment: this.detectSentiment(text),
        language,
        needs_human_reply: true,
        reason: 'Question pattern detected.',
        source: 'heuristic'
      };
    }

    return {
      kind: 'general_follow_up',
      confidence: 0.6,
      urgency: this.includesAny(text, ['today', 'asap', 'urgent']) ? 'high' : 'low',
      sentiment: this.detectSentiment(text),
      language,
      needs_human_reply: true,
      reason: 'Default follow-up classification.',
      source: 'heuristic'
    };
  }

  private detectLanguage(text: string): 'en' | 'fr' | 'other' {
    if (this.includesAny(text, ['bonjour', 'merci', 'salut', 'appartement', 'maison', 'visite'])) {
      return 'fr';
    }
    if (/[a-z]/.test(text)) {
      return 'en';
    }
    return 'other';
  }

  private detectSentiment(text: string): 'positive' | 'neutral' | 'negative' {
    if (this.includesAny(text, ['thanks', 'thank you', 'great', 'perfect', 'awesome', 'merci'])) {
      return 'positive';
    }
    if (this.includesAny(text, ['not interested', 'frustrated', 'upset', 'angry', 'too expensive'])) {
      return 'negative';
    }
    return 'neutral';
  }

  private includesAny(text: string, candidates: string[]): boolean {
    return candidates.some((candidate) => text.includes(candidate));
  }

  private parseModelJson(text: string): unknown | null {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (!match) {
        return null;
      }

      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }
}
