import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DEFAULT_SAAS_RUBRIC, computeEvaluationFromDecisions } from '../packages/shared/dist/index.js';
import { loadConfig } from '../backend/dist/config.js';
import { GeminiDecisionEngine } from '../backend/dist/services/geminiDecision.js';

// Load local .env without extra dependencies
const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Tiny 5x7 bitmap font to render legible synthetic text directly into a real PNG buffer
const FONT = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['01110','10000','11110','10001','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
  'A': ['01110','10001','10001','11111','10001','10001','10001'],
  'C': ['01110','10001','10000','10000','10000','10001','01110'],
  'D': ['11110','10001','10001','10001','10001','10001','11110'],
  'E': ['11111','10000','10000','11110','10000','10000','11111'],
  'I': ['01110','00100','00100','00100','00100','00100','01110'],
  'K': ['10001','10010','10100','11000','10100','10010','10001'],
  'L': ['10000','10000','10000','10000','10000','10000','11111'],
  'M': ['10001','11011','10101','10101','10001','10001','10001'],
  'N': ['10001','11001','10101','10011','10001','10001','10001'],
  'O': ['01110','10001','10001','10001','10001','10001','01110'],
  'P': ['11110','10001','10001','11110','10000','10000','10000'],
  'R': ['11110','10001','10001','11110','10100','10010','10001'],
  'S': ['01111','10000','10000','01110','00001','00001','11110'],
  'T': ['11111','00100','00100','00100','00100','00100','00100'],
  'U': ['10001','10001','10001','10001','10001','10001','01110'],
  'V': ['10001','10001','10001','10001','10001','01010','00100'],
  'W': ['10001','10001','10001','10101','10101','11011','10001'],
  'X': ['10001','10001','01010','00100','01010','10001','10001'],
  'Y': ['10001','10001','01010','00100','00100','00100','00100'],
  ':': ['00000','00100','00100','00000','00100','00100','00000'],
  '/': ['00001','00010','00100','00100','01000','10000','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
};

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function renderTextCardPng(lines, bg = [18, 42, 74], fg = [245, 248, 255]) {
  const w = 640, h = 360, scale = 4;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = 255;
  }
  lines.forEach((line, rowIdx) => {
    const y0 = 48 + rowIdx * 56;
    const upper = line.toUpperCase();
    for (let ci = 0; ci < upper.length; ci++) {
      const glyph = FONT[upper[ci]] || FONT[' '];
      const x0 = 36 + ci * (6 * scale);
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy][gx] !== '1') continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = x0 + gx * scale + sx;
              const py = y0 + gy * scale + sy;
              if (px >= 0 && px < w && py >= 0 && py < h) {
                const idx = (py * w + px) * 4;
                rgba[idx] = fg[0]; rgba[idx + 1] = fg[1]; rgba[idx + 2] = fg[2]; rgba[idx + 3] = 255;
              }
            }
          }
        }
      }
    }
  });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function makeSimplePdf(textLines) {
  const esc = (s) => s.replace(/([()\\])/g, '\\$1');
  const stream = ['BT', '/F1 14 Tf', '50 720 Td', ...textLines.flatMap((l, i) => [i === 0 ? `(${esc(l)}) Tj` : `0 -22 Td (${esc(l)}) Tj`]), 'ET'].join('\n');
  const objs = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(stream, 'utf8')} >> stream\n${stream}\nendstream endobj`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) { offsets.push(Buffer.byteLength(pdf, 'utf8')); pdf += o + '\n'; }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

const config = loadConfig();
const engine = new GeminiDecisionEngine(config);

const cardPng = renderTextCardPng([
  'VISA PLATINUM CARD',
  '4532 1190 8821 4242',
  'EXP: 09/29  CVV: 842',
  'HOLDER: ALEX COHEN',
]);
const syntheticStripe = ['sk', 'live', '51Nx9aK7mP2qR8vL4wT6yB3cZ9xF1dH8jM2nQ5'].join('_');
const syntheticGoogle = ['AIza', 'SyB9xK4mP2qR7vL3wT8yN1cZ6fH0jM4nQ8'].join('');
const apiPdf = makeSimplePdf([
  'Production Server Error Log - Invoice Webhook',
  `Authorization: Bearer ${syntheticStripe}`,
  `GEMINI_API_KEY=${syntheticGoogle}`,
  'HTTP 401 Unauthorized on /v1/charges',
]);
const cleanPng = renderTextCardPng([
  'ORDER STATUS: SHIPPED',
  'TRACKING: ORD-8821',
  'TOTAL PAID: USD 79',
], [240, 245, 248], [15, 28, 36]);

const cases = [
  {
    name: '1) Fake Credit Card Screenshot (visual-only PII, clean text!)',
    transcript: 'Customer: Please check the attached screenshot to verify my billing method.\nAgent: Thanks! I verified your order #8821 and issued the refund today (3-5 business days).',
    attachments: [{ attachmentId: 'a1', commentId: 'c1', filename: 'attachment_01.png', contentUrl: '', mimeType: 'image/png', bytes: cardPng }],
  },
  {
    name: '2) Fake API Key in PDF Attachment (PDF-only PII, clean text!)',
    transcript: 'Customer: Attached the PDF log of our 401 error.\nAgent: Thank you, I reviewed your PDF log. Please rotate your exposed credentials immediately and retry with our new endpoint.',
    attachments: [{ attachmentId: 'a2', commentId: 'c2', filename: 'debug_log.pdf', contentUrl: '', mimeType: 'application/pdf', bytes: apiPdf }],
  },
  {
    name: '3) Clean Order Status Screenshot (Zero PII control)',
    transcript: 'Customer: Here is a screenshot of my order page. When will it arrive?\nAgent: Hi! Order ORD-8821 has already shipped and will arrive within 2 business days. Let me know if you need anything else.',
    attachments: [{ attachmentId: 'a3', commentId: 'c3', filename: 'order_screen.png', contentUrl: '', mimeType: 'image/png', bytes: cleanPng }],
  },
];

for (const tc of cases) {
  console.log(`\n=== ${tc.name} ===`);
  const exec = await engine.evaluate(DEFAULT_SAAS_RUBRIC, tc.transcript, tc.attachments);
  const computed = computeEvaluationFromDecisions(DEFAULT_SAAS_RUBRIC, exec.response, false);
  console.log({
    modelUsed: exec.modelUsed,
    latencyMs: exec.latencyMs,
    inputTokens: exec.inputTokens,
    outputTokens: exec.response.usage?.output_tokens ?? exec.response.usage?.total_output_tokens ?? 0,
    overallScore: computed.overallScore,
    passed: computed.passed,
    piiDetected: computed.piiDetected,
    piiSeverity: computed.piiSeverity,
    flaggedPii: computed.piiResults.filter((r) => r.flagged).map((r) => `${r.category}: p=${r.probability}, conf=${r.confidence}`),
  });
}
