# RubricCheck QA — Zendesk Marketplace App

Flat-rate SMB Automated QA & Multimodal Screenshot/PDF PII Guardrail for Zendesk Support (5–40+ agents), powered by **Google Gemini Decisions API (`gemini-decision-1`)** and **Paddle Billing**.

## Architecture

- **`packages/shared`**: Zod v4 schemas, `gemini-decision-1` question builder (`noul`, `score`, `choice`), weighted scoring math, and 3 B2B rubric templates.
- **`backend`**: Node 24 + Hono TypeScript API designed for **Google Cloud Run** (with zero-config built-in SQLite for local dev/CI). Includes:
  - Zendesk Global OAuth 2.0 + rotating Refresh Token manager (AES-256-GCM encrypted at rest)
  - ZAF `signedUrls` RS256 JWT verification
  - Zendesk Event Webhooks (`ticket.attachment_linked_to_comment`, `ticket.comment_added`, `ticket.status_changed`, `ticket.attachment_redacted_from_comment`) with HMAC-SHA256 verification
  - Zendesk Comment Redaction API (`PUT /api/v2/comment_redactions/{comment_id}`)
  - `gemini-decision-1` multimodal engine (RAM-only attachment scanning, zero disk persistence, Paid Tier zero-training compliant)
  - Paddle Billing webhook sync & Customer Portal integration
- **`frontend`**: React + Vite + TypeScript UI serving both ZAF `ticket_sidebar` (320px tray) and `nav_bar` (full QA & PII Dashboard, Rubric Builder, Multimodal Tester, Billing).
- **`zaf-app`**: Zendesk Apps Framework v2 submission package (`manifest.json`, `translations/en.json`, icons & screenshots) validated via `zcli`.
- **`docs`**: Static GitHub Pages site (Landing + Savings Calculator, Pricing, AI Privacy Policy, Terms of Service, Support).

## Local Development

```bash
npm install
npm run build
npm test
npm run dev:backend   # http://localhost:8787
npm run dev:frontend  # http://localhost:5173
```

## ZCLI Validation & Packaging

```bash
npm run zaf:validate
npm run zaf:package
```

## Deploy to Google Cloud Run

```powershell
./scripts/deploy-cloudrun.ps1 -ProjectId "<YOUR_GCP_PROJECT_ID>"
```
