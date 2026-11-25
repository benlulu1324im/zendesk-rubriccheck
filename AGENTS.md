# RubricCheck QA — Project Agent Rules (`AGENTS.md`)

## 1. Permanent `STATUS.md` Auto-Update Rule
At the end of every significant phase, test run, deployment, or stop-for-approval checkpoint, automatically create/update `STATUS.md` in the repository root.

- Maximum length: **35 lines**.
- Keep it updated in real time and strictly in this exact structure:
  ```markdown
  # [Project Name] — Status
  - **Last Updated:** YYYY-MM-DD HH:MM
  - **Current Phase:** [Phase 1/2/3/4] ([estimated %]%)
  - **Health:** [GREEN / YELLOW / BLOCKED]
  - **Guardrails Check:** [Short confirmation of iron rules]
  - **Completed:** (3–5 short bullets of verified completed work)
  - **In Progress:** (what is running now)
  - **Blockers / Waiting on User:** (what is waiting on user, or "None")
  - **Live Links & Artifacts:** (Dev URL, GitHub Pages, Repo, Sandbox IDs)
  - **Next Step:** (exact next step)
  ```

## 2. Communication & Language
- All chat messages, status updates, questions, and approval requests to the user must be in **short, direct Hebrew** (keep code, CLI commands, technical terms, and URLs in English).

## 3. Non-Negotiable Product & Billing Guardrails
1. **Paddle Live Safety Lock:** Use **Paddle Sandbox MCP ONLY** during all development, testing, and QA. NEVER create, edit, archive, or delete anything in **Paddle Live MCP** without explicit Hebrew approval at the Phase 4 launch gate.
2. **Shared Paddle Account Isolation (Sandbox & Live):**
   - NEVER change the global Default Payment Link or global Checkout settings. Always pass a transaction-specific `checkout.url` or open via `Paddle.Checkout.open({ items / transactionId })` on our own page.
   - NEVER edit, archive, or delete any existing Product, Price, Discount, or Notification Destination (the account hosts active Framer template products). Only touch entities prefixed `RubricCheck QA` with `custom_data.app = "rubriccheck-qa"`.
   - `/webhooks/paddle` MUST filter events strictly by RubricCheck QA `product_id` / `price_id` or `custom_data.app === "rubriccheck-qa"`, returning silent `200 OK` for all unrelated events.
3. **Auto-Redact Safety Lock:** Attachment Auto-Redact must ALWAYS be **OFF by default (Opt-in only)**, require explicit admin irreversible-deletion confirmation, and trigger ONLY when BOTH probability and confidence are `>= 0.95`.
4. **Zendesk OAuth & AI Privacy:** Production integration uses **Zendesk OAuth 2.0** (minimal scopes + refresh rotation) and **Paid-tier `gemini-decision-1`** (zero model training, RAM-only attachment processing).
