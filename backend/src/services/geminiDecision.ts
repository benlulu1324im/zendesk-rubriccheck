import {
  DecisionApiResponseSchema,
  buildDecisionQuestions,
  type DecisionApiResponse,
  type DecisionQuestion,
  type ImageResolution,
  type RubricInput,
} from '@rubriccheck/shared';
import type { AppConfig } from '../config.js';

export interface InMemoryAttachment {
  attachmentId: string;
  commentId: string;
  filename: string;
  contentUrl: string;
  mimeType: string;
  bytes: Buffer;
}

export interface DecisionExecutionResult {
  response: DecisionApiResponse;
  modelUsed: string;
  inputTokens: number;
  latencyMs: number;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mime_type: string; resolution: ImageResolution }
  | { type: 'document'; data: string; mime_type: 'application/pdf' };

const DECISIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';

export class GeminiDecisionEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildInputBlocks(
    transcriptText: string,
    attachments: InMemoryAttachment[],
    imageResolution: ImageResolution,
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        text: transcriptText.slice(0, 120_000),
      },
    ];

    for (const att of attachments) {
      if (att.mimeType === 'application/pdf') {
        blocks.push({
          type: 'text',
          text: `[Attached PDF Document: ${att.filename}]`,
        });
        blocks.push({
          type: 'document',
          data: att.bytes.toString('base64'),
          mime_type: 'application/pdf',
        });
      } else if (att.mimeType.startsWith('image/')) {
        blocks.push({
          type: 'text',
          text: `[Attached Image/Screenshot: ${att.filename}]`,
        });
        blocks.push({
          type: 'image',
          data: att.bytes.toString('base64'),
          mime_type: att.mimeType,
          resolution: imageResolution,
        });
      }
    }

    return blocks;
  }

  async evaluate(
    rubric: RubricInput,
    transcriptText: string,
    attachments: InMemoryAttachment[],
  ): Promise<DecisionExecutionResult> {
    const questions = buildDecisionQuestions(rubric);
    const inputBlocks = this.buildInputBlocks(
      transcriptText,
      attachments,
      rubric.piiConfig.imageResolution,
    );

    if (!this.config.geminiApiKey) {
      if (this.config.nodeEnv === 'production') {
        throw new Error('GEMINI_API_KEY is required in production (Paid Tier required for zero-training)');
      }
      return this.runLocalSimulation(questions, transcriptText, attachments);
    }

    const start = Date.now();
    try {
      const res = await this.callDecisionsApi(inputBlocks, questions);
      const latencyMs = Date.now() - start;
      const inputTokens =
        res.usage?.input_tokens ?? res.usage?.total_input_tokens ?? Math.ceil(transcriptText.length / 4);
      return {
        response: res,
        modelUsed: this.config.geminiDecisionModel,
        inputTokens,
        latencyMs,
      };
    } catch (err) {
      if (!this.config.geminiAllowFallback) {
        throw err;
      }
      // Graceful fallback to gemini-3.5-flash-lite with store:false if v1beta/decisions fails transiently
      const fallbackRes = await this.callFallbackStructuredModel(transcriptText, attachments, questions);
      return {
        response: fallbackRes,
        modelUsed: `${this.config.geminiFallbackModel} (fallback)`,
        inputTokens: fallbackRes.usage?.input_tokens ?? Math.ceil(transcriptText.length / 4),
        latencyMs: Date.now() - start,
      };
    }
  }

  private async callDecisionsApi(
    input: ContentBlock[],
    questions: Record<string, DecisionQuestion>,
  ): Promise<DecisionApiResponse> {
    const res = await this.fetchImpl(DECISIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.geminiApiKey,
      },
      body: JSON.stringify({
        model: this.config.geminiDecisionModel,
        input,
        questions,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini Decisions API error (${res.status}): ${errText.slice(0, 400)}`);
    }

    const raw = await res.json();
    return DecisionApiResponseSchema.parse(raw);
  }

  private async callFallbackStructuredModel(
    transcriptText: string,
    attachments: InMemoryAttachment[],
    questions: Record<string, DecisionQuestion>,
  ): Promise<DecisionApiResponse> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions`;
    const prompt = [
      'Return ONLY valid JSON matching {"answers": { ... }} for each question key.',
      'For type="noul": {"type":"noul","noul":0.01..0.99,"confidence":0..1}.',
      'For type="score": {"type":"score","score":0..(levels-1),"confidence":0..1}.',
      'For type="choice": {"type":"choice","choice":"<key>","confidence":0..1}.',
      `Questions JSON:\n${JSON.stringify(questions)}`,
      `\nTicket Context:\n${transcriptText.slice(0, 50_000)}`,
    ].join('\n');

    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
    for (const att of attachments.slice(0, 4)) {
      if (att.mimeType === 'application/pdf') {
        content.push({
          type: 'document',
          data: att.bytes.toString('base64'),
          mime_type: 'application/pdf',
        });
      } else if (att.mimeType.startsWith('image/')) {
        content.push({
          type: 'image',
          data: att.bytes.toString('base64'),
          mime_type: att.mimeType,
        });
      }
    }

    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.geminiApiKey,
      },
      body: JSON.stringify({
        model: this.config.geminiFallbackModel,
        store: false,
        input: content,
        generation_config: { response_mime_type: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini fallback API error (${res.status}): ${errText.slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      output_text?: string;
      steps?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage?: { input_tokens?: number };
    };
    const text =
      data.output_text ??
      data.steps
        ?.filter((s) => s.type === 'model_output')
        .flatMap((s) => s.content ?? [])
        .find((c) => c.type === 'text')?.text;

    if (!text) {
      throw new Error('Gemini fallback returned empty output');
    }
    const parsed = JSON.parse(text);
    return DecisionApiResponseSchema.parse({
      answers: parsed.answers ?? parsed,
      usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: 0 },
    });
  }

  /**
   * Deterministic local dev simulation when GEMINI_API_KEY is unset (dev/test only).
   * Inspects filenames & text patterns so UI workflows can be exercised offline.
   */
  private runLocalSimulation(
    questions: Record<string, DecisionQuestion>,
    transcriptText: string,
    attachments: InMemoryAttachment[],
  ): DecisionExecutionResult {
    const combined = `${transcriptText} ${attachments.map((a) => a.filename).join(' ')}`.toLowerCase();
    const hasCard = /\b(?:\d[ -]*?){13,16}\b|visa|mastercard|card_photo|credit[-_]?card/.test(combined);
    const hasApiKey = /sk_live_|aiza[0-9a-z_-]{10,}|ghp_[0-9a-z]{10,}|api[-_]?key/.test(combined);
    const hasGovId = /passport|driver[-_]?license|id[-_]?card|teudat/.test(combined);
    const hasSsn = /\b\d{3}-\d{2}-\d{4}\b|ssn|tax[-_]?id/.test(combined);
    const hasPassword = /password\s*[:=]|seed phrase|recovery code/.test(combined);
    const hasIban = /\b[a-z]{2}\d{2}[a-z0-9]{11,28}\b|iban|bank[-_]?statement/.test(combined);

    const answers: DecisionApiResponse['answers'] = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.type === 'score') {
        const maxIdx = q.criteria.length - 1;
        const rude = /shut up|not my problem|whatever/.test(combined);
        const val = rude ? Math.min(1, maxIdx) : Number((maxIdx * 0.84).toFixed(2));
        answers[key] = { type: 'score', score: val, confidence: 0.91 };
      } else if (q.type === 'noul') {
        if (key === 'pii_credit_card') {
          answers[key] = { type: 'noul', noul: hasCard ? 0.96 : 0.03, confidence: 0.94 };
        } else if (key === 'pii_api_key_secret') {
          answers[key] = { type: 'noul', noul: hasApiKey ? 0.95 : 0.04, confidence: 0.93 };
        } else if (key === 'pii_gov_id') {
          answers[key] = { type: 'noul', noul: hasGovId ? 0.94 : 0.02, confidence: 0.95 };
        } else if (key === 'pii_ssn_national_id') {
          answers[key] = { type: 'noul', noul: hasSsn ? 0.93 : 0.02, confidence: 0.94 };
        } else if (key === 'pii_password_credentials') {
          answers[key] = { type: 'noul', noul: hasPassword ? 0.92 : 0.02, confidence: 0.93 };
        } else if (key === 'pii_bank_iban') {
          answers[key] = { type: 'noul', noul: hasIban ? 0.91 : 0.03, confidence: 0.92 };
        } else {
          answers[key] = { type: 'noul', noul: 0.91, confidence: 0.89 };
        }
      } else if (q.type === 'choice') {
        if (key === 'pii_severity') {
          const critical = hasCard || hasApiKey || hasGovId || hasSsn || hasPassword;
          const high = hasIban;
          answers[key] = {
            type: 'choice',
            choice: critical ? 'critical' : high ? 'high' : 'none',
            confidence: 0.94,
          };
        } else {
          const anyPii = hasCard || hasApiKey || hasGovId || hasSsn || hasPassword || hasIban;
          answers[key] = {
            type: 'choice',
            choice: anyPii ? 'urgent_compliance' : 'none',
            confidence: 0.9,
          };
        }
      }
    }

    return {
      response: {
        answers,
        usage: {
          input_tokens: Math.max(450, Math.ceil(transcriptText.length / 4) + attachments.length * 1024),
          output_tokens: 0,
        },
      },
      modelUsed: `${this.config.geminiDecisionModel} (dev-sim)`,
      inputTokens: Math.max(450, Math.ceil(transcriptText.length / 4) + attachments.length * 1024),
      latencyMs: 185,
    };
  }
}
