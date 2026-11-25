# RubricCheck QA — Architecture & Execution Plan

> **Zendesk Marketplace App:** Flat-rate Automated QA & Multimodal Screenshot/PDF PII Guardrail for SMB Support Teams (5–40 agents).

## 1. Verified Late-2026 Research Findings

- **AI Engine (`gemini-decision-1` — Gemini Decisions API):**
  - Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/decisions` (SDK: `@google/genai` >= 3.2, `apiVersion: 'v1beta'`).
  - Native multimodal input up to **262,144 tokens** (text, images with `resolution: 'low'|'medium'|'high'|'ultra_high'`, PDFs via `{ type: 'document', data, mime_type: 'application/pdf' }`).
  - Up to **1,000 independent typed questions** per call: `noul` (Yes/No calibrated probability `0.01–0.99`), `choice` (2–255 discrete options), `score` (2–255 ordered rubric levels).
  - Latency: **150–250ms** end-to-end. Cost: **\$0.10 / 1M input tokens**, **\$0 output tokens** (~0.045¢ per ticket).
  - **Privacy Guardrail:** Must use Google AI Studio **Paid Tier** API key (Zero Model Training). All attachments and raw ticket bodies are processed strictly **in-memory (RAM-only)** with zero persistence on disk or DB. Wrapped behind `DecisionEngineAdapter` with Zod validation and automatic fallback to `gemini-3.5-flash-lite` (`store: false`) if `v1beta` is unavailable.
- **Zendesk OAuth 2.0 & Webhooks (Mandatory Late-2026 Rules):**
  - Permanent API tokens retire **April 30, 2027**. Public apps require **Global OAuth** (local dev client prefix `zdg-rubriccheck-qa`) with mandatory **Refresh Token flow** (30m access token TTL, 30d refresh token TTL) and granular scopes: `tickets:read tickets:write webhooks:read webhooks:write`.
  - Event-based webhooks (`POST /api/v2/webhooks`): `zen:event-type:ticket.attachment_linked_to_comment`, `zen:event-type:ticket.comment_added`, `zen:event-type:ticket.status_changed`, `zen:event-type:ticket.attachment_redacted_from_comment`, verified via `X-Zendesk-Webhook-Signature` (Base64 HMAC-SHA256 of `timestamp + rawBody`).
  - Attachment redaction (including closed tickets): `PUT /api/v2/comment_redactions/{comment_id}` with `{ ticket_id, external_attachment_urls }`.
- **Zendesk Marketplace & ZAF v2:**
  - Listed as **"Free to install"** with **"Additional fees"** (0% Zendesk commission) linking to external Pricing URL, Privacy Policy, Terms of Service, and Support pages (GitHub Pages in `docs/`).
  - `manifest.json` (`frameworkVersion: "2.0"`, `signedUrls: true` RS256 JWT verification via `/api/v2/apps/{app_id}/public_key.pem`, locations `ticket_sidebar` + `nav_bar`).
  - Assets validated via `zcli apps:validate` and packaged via `zcli apps:package` (`logo.png` 320×320, `logo-small.png` 128×128, `screenshot-0..2.png`).
- **Billing & Licensing (Paddle Billing — Merchant of Record):**
  - Israeli Authorized Dealer friendly (Paddle acts as Merchant of Record across 200+ countries).
  - Flat per-account unlimited-agent tiers:
    - **Free:** \$0/mo — 100 tickets/mo, 1 rubric (up to 5 criteria), PII flagging + 1-click redaction.
    - **Starter:** \$79/mo (\$69/mo annual) — 1,500 tickets/mo, 3 rubrics, PII alerts + 1-click redaction.
    - **Growth:** \$149/mo (\$129/mo annual) — 5,000 tickets/mo, unlimited rubrics, Auto-Redact rules, CSV export.
    - **Scale:** \$299/mo (\$249/mo annual) — 15,000 tickets/mo, multi-brand rubrics, priority queue.
  - **SAFETY LOCK (Shared Paddle Account Isolation — applies to BOTH Sandbox & Live):**
    - All dev/QA uses **Paddle Sandbox ONLY**. Paddle Live requires explicit human approval at Phase 4.
    - **Rule 1 (Never touch Global Checkout Settings):** NEVER modify the account's global Default Payment Link or global Checkout settings. Always pass a specific `checkout.url` inside transaction creation or open checkout directly via `Paddle.Checkout.open({ items / transactionId })` on our own page.
    - **Rule 2 (Zero-Touch on Existing Entities):** NEVER delete, archive, or edit any existing Product, Price, Discount, or Notification Destination (e.g. Framer templates / other apps). Operate strictly on newly created entities prefixed with `RubricCheck QA` and tagged `custom_data.app = "rubriccheck-qa"`.
    - **Rule 3 (Strict Webhook Filtering):** The `/webhooks/paddle` handler MUST filter incoming events strictly by RubricCheck QA's `product_id` / `price_id` (or `custom_data.app === "rubriccheck-qa"`), returning a silent `200 OK` (`{ ok: true, ignored: true }`) for any event belonging to other products in the shared account.
  - **Auto-Redact Safety Lock:** Always **OFF by default (Opt-in only)** across all rubrics/templates, requires explicit admin confirmation warning that Zendesk attachment deletion is permanent and irreversible (`autoRedactAcknowledgedIrreversible: true`), and triggers only at a strict `>= 0.95` probability AND `>= 0.95` model confidence floor.

## 2. Monorepo Structure

```text
zendesk-rubriccheck/
├── PLAN.md
├── package.json              # npm workspaces root
├── tsconfig.base.json
├── packages/shared/          # Zod schemas, rubric & plan types, scoring math
├── backend/                  # Hono + Node 24 TypeScript API, DB (SQLite dev / Postgres prod)
├── frontend/                 # React + Vite + Tailwind ZAF UI (ticket_sidebar + nav_bar)
├── zaf-app/                  # Zendesk ZAF v2 manifest, translations, icons, screenshots
└── docs/                     # GitHub Pages site (Landing, Pricing, Privacy, Terms, Support)
```

## 3. Execution Phases

- **Phase 1 (Done):** Live research, architecture spec, and `PLAN.md`.
- **Phase 2:** Paddle Sandbox catalog setup + Backend/DB/Frontend scaffolding.
- **Phase 3:** Full implementation, automated test suite, Browser Visual QA across breakpoints, and real Zendesk Sandbox E2E testing (fake PII screenshots & PDFs).
- **Phase 4:** ZCLI validation/packaging, Marketplace assets, GitHub Pages legal/pricing site, and **STOP for explicit approval** before Paddle Live creation or Zendesk Marketplace/Global OAuth submission.
