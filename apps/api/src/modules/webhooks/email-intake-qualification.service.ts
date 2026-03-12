import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

import { EmailClassifierService } from '../ai/email-classifier.service';

export type EmailIntakeDecision = 'create_lead' | 'needs_review' | 'reject';
export type EmailIngestSource = 'webhook' | 'poll' | 'backfill';

type EmailClassification = Awaited<ReturnType<EmailClassifierService['classifyInboundEmail']>>;

export interface EmailIntakeDecisionReason {
  code: string;
  kind: 'hard_filter' | 'signal' | 'threshold';
  detail: string;
  weight?: number | undefined;
}

export interface QualifiedInboundEmailIntake {
  normalized_from_email: string;
  sender_localpart: string;
  sender_domain: string;
  body_fingerprint: string;
  classifier: EmailClassification;
  score: number;
  decision: EmailIntakeDecision;
  reasons: EmailIntakeDecisionReason[];
}

const DEFAULT_BLOCKED_LOCALPARTS = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'system'];
const DEFAULT_BLOCKED_DOMAINS = ['example.com', 'example.org'];
const DEFAULT_DISPOSABLE_DOMAINS = [
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'yopmail.com',
  'tempmail.com'
];

@Injectable()
export class EmailIntakeQualificationService {
  constructor(
    private readonly configService: ConfigService,
    private readonly emailClassifierService: EmailClassifierService
  ) {}

  async qualifyInboundEmail(input: {
    fromEmail: string;
    subject?: string | undefined;
    body?: string | undefined;
  }): Promise<QualifiedInboundEmailIntake> {
    const normalizedFromEmail = this.normalizeEmail(input.fromEmail);
    const [senderLocalpart, senderDomain] = this.splitEmail(normalizedFromEmail);
    const subject = (input.subject ?? '').trim();
    const body = (input.body ?? '').trim();
    const text = `${subject}\n${body}`.toLowerCase();

    const classifier = await this.emailClassifierService.classifyInboundEmail({
      fromEmail: normalizedFromEmail,
      subject,
      body
    });

    const reasons: EmailIntakeDecisionReason[] = [];
    const hardReject = this.applyHardFilters({
      senderLocalpart,
      senderDomain,
      text,
      classifier,
      reasons
    });

    const score = hardReject ? 0 : this.computeScore({ text, subject, body, classifier, reasons });
    const decision = this.mapDecision(score, hardReject);
    reasons.push({
      code: 'decision_threshold',
      kind: 'threshold',
      detail: hardReject
        ? 'Rejected due to hard filter.'
        : `Score ${score} mapped to decision ${decision} using thresholds create>=${this.getCreateThreshold()} and review>=${this.getReviewThreshold()}.`
    });

    return {
      normalized_from_email: normalizedFromEmail,
      sender_localpart: senderLocalpart,
      sender_domain: senderDomain,
      body_fingerprint: this.bodyFingerprint(body),
      classifier,
      score,
      decision,
      reasons
    };
  }

  mapDecision(score: number, hardReject = false): EmailIntakeDecision {
    if (hardReject) {
      return 'reject';
    }

    if (score >= this.getCreateThreshold()) {
      return 'create_lead';
    }

    if (score >= this.getReviewThreshold()) {
      return 'needs_review';
    }

    return 'reject';
  }

  private applyHardFilters(input: {
    senderLocalpart: string;
    senderDomain: string;
    text: string;
    classifier: EmailClassification;
    reasons: EmailIntakeDecisionReason[];
  }): boolean {
    const blockedLocalparts = this.getCsvSet('EMAIL_INTAKE_BLOCKED_LOCALPARTS', DEFAULT_BLOCKED_LOCALPARTS);
    const blockedDomains = this.getCsvSet('EMAIL_INTAKE_BLOCKED_DOMAINS', DEFAULT_BLOCKED_DOMAINS);
    const disposableDomains = this.getCsvSet('EMAIL_INTAKE_DISPOSABLE_DOMAINS', DEFAULT_DISPOSABLE_DOMAINS);

    let hardReject = false;
    if (blockedLocalparts.has(input.senderLocalpart)) {
      hardReject = true;
      input.reasons.push({
        code: 'blocked_localpart',
        kind: 'hard_filter',
        detail: `Sender localpart "${input.senderLocalpart}" is blocked.`
      });
    }

    if (blockedDomains.has(input.senderDomain)) {
      hardReject = true;
      input.reasons.push({
        code: 'blocked_domain',
        kind: 'hard_filter',
        detail: `Sender domain "${input.senderDomain}" is blocked.`
      });
    }

    if (disposableDomains.has(input.senderDomain)) {
      hardReject = true;
      input.reasons.push({
        code: 'disposable_domain',
        kind: 'hard_filter',
        detail: `Sender domain "${input.senderDomain}" is disposable.`
      });
    }

    if (['auto_reply', 'opt_out', 'spam_or_unrelated'].includes(input.classifier.kind)) {
      hardReject = true;
      input.reasons.push({
        code: 'classifier_hard_reject_kind',
        kind: 'hard_filter',
        detail: `Classifier kind "${input.classifier.kind}" is configured as hard reject.`
      });
    }

    if (this.includesAny(input.text, ['unsubscribe', 'do not contact', 'remove me'])) {
      hardReject = true;
      input.reasons.push({
        code: 'opt_out_language',
        kind: 'hard_filter',
        detail: 'Opt-out language detected.'
      });
    }

    if (this.includesAny(input.text, ['out of office', 'automatic reply', 'auto-reply', 'vacation responder'])) {
      hardReject = true;
      input.reasons.push({
        code: 'auto_reply_language',
        kind: 'hard_filter',
        detail: 'Auto-reply language detected.'
      });
    }

    if (this.includesAny(input.text, ['bitcoin', 'gift card', 'wire transfer'])) {
      hardReject = true;
      input.reasons.push({
        code: 'spam_signal',
        kind: 'hard_filter',
        detail: 'Spam language detected.'
      });
    }

    return hardReject;
  }

  private computeScore(input: {
    text: string;
    subject: string;
    body: string;
    classifier: EmailClassification;
    reasons: EmailIntakeDecisionReason[];
  }): number {
    let score = 35;
    const apply = (code: string, detail: string, weight: number): void => {
      score += weight;
      input.reasons.push({
        code,
        kind: 'signal',
        detail,
        weight
      });
    };

    if (input.subject.length > 0) {
      apply('has_subject', 'Subject present.', 4);
    }

    if (input.body.length >= 20) {
      apply('body_length_signal', 'Body has substantial content.', 10);
    } else {
      apply('short_body_penalty', 'Body is very short.', -12);
    }

    if (input.text.includes('?') || this.includesAny(input.text, ['can you', 'could you', 'what', 'when', 'where', 'how'])) {
      apply('question_signal', 'Question pattern detected.', 8);
    }

    if (this.includesAny(input.text, ['showing', 'tour', 'visit', 'appointment', 'available'])) {
      apply('showing_signal', 'Showing or scheduling intent detected.', 15);
    }

    if (this.includesAny(input.text, ['price', 'budget', 'mortgage', 'financing', 'rate'])) {
      apply('pricing_signal', 'Pricing or financing signal detected.', 10);
    }

    if (this.includesAny(input.text, ['buy', 'interested', 'looking for', 'property', 'home'])) {
      apply('buyer_intent_signal', 'Buying intent signal detected.', 12);
    }

    if (this.includesAny(input.text, ['not interested', 'already bought', 'too expensive'])) {
      apply('objection_signal', 'Objection signal detected.', -18);
    }

    switch (input.classifier.kind) {
      case 'showing_request':
        apply('classifier_showing_request', 'Classifier indicates showing request.', 18);
        break;
      case 'property_question':
        apply('classifier_property_question', 'Classifier indicates property question.', 14);
        break;
      case 'pricing_or_financing':
        apply('classifier_pricing_financing', 'Classifier indicates pricing/financing.', 12);
        break;
      case 'general_follow_up':
        apply('classifier_follow_up', 'Classifier indicates general follow-up.', 8);
        break;
      case 'objection':
        apply('classifier_objection', 'Classifier indicates objection.', -12);
        break;
      default:
        apply('classifier_other', `Classifier kind is ${input.classifier.kind}.`, 0);
        break;
    }

    const confidenceWeight = Math.round((input.classifier.confidence - 0.5) * 20);
    apply(
      'classifier_confidence',
      `Classifier confidence adjustment (${input.classifier.confidence.toFixed(2)}).`,
      confidenceWeight
    );

    apply(
      'classifier_reply_need',
      input.classifier.needs_human_reply
        ? 'Classifier indicates a human reply is needed.'
        : 'Classifier indicates no human reply needed.',
      input.classifier.needs_human_reply ? 10 : -10
    );

    if (input.classifier.urgency === 'high') {
      apply('classifier_urgency_high', 'Classifier urgency high.', 8);
    } else if (input.classifier.urgency === 'medium') {
      apply('classifier_urgency_medium', 'Classifier urgency medium.', 4);
    }

    if (input.classifier.sentiment === 'negative') {
      apply('classifier_negative_sentiment', 'Negative sentiment adjustment.', -4);
    } else if (input.classifier.sentiment === 'positive') {
      apply('classifier_positive_sentiment', 'Positive sentiment adjustment.', 2);
    }

    return Math.max(0, Math.min(100, score));
  }

  private getCreateThreshold(): number {
    return this.getInt('EMAIL_INTAKE_CREATE_THRESHOLD', 70, 0, 100);
  }

  private getReviewThreshold(): number {
    return this.getInt('EMAIL_INTAKE_REVIEW_THRESHOLD', 40, 0, 100);
  }

  private getInt(key: string, fallback: number, min: number, max: number): number {
    const raw = this.configService.get<string>(key);
    if (!raw) {
      return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.max(min, Math.min(max, parsed));
  }

  private getCsvSet(key: string, fallback: string[]): Set<string> {
    const raw = this.configService.get<string>(key);
    if (!raw) {
      return new Set(fallback.map((value) => value.toLowerCase()));
    }

    const parsed = raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);

    if (!parsed.length) {
      return new Set(fallback.map((value) => value.toLowerCase()));
    }

    return new Set(parsed);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private splitEmail(email: string): [string, string] {
    const [localpartRaw, domainRaw] = email.split('@');
    const localpart = (localpartRaw ?? '').trim().toLowerCase();
    const domain = (domainRaw ?? '').trim().toLowerCase();
    return [localpart, domain];
  }

  private bodyFingerprint(body: string): string {
    const normalized = body.trim().toLowerCase().replace(/\s+/g, ' ');
    return createHash('sha256').update(normalized).digest('hex');
  }

  private includesAny(text: string, candidates: string[]): boolean {
    return candidates.some((candidate) => text.includes(candidate));
  }
}
