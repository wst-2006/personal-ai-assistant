# Development Rules

- Follow the product rules in `docs/PRODUCT_SPEC.md`; user approval is required before automatic plan changes.
- This is a single-user application in v1. Do not add public registration, multi-tenant features, social features, surveillance, personality inference, or punishment mechanics.
- Keep AI, database, reminders, and external providers behind module boundaries. API keys are server-only and never committed.
- Use explicit state machines from `docs/STATE_MACHINES.md`; do not infer state from conversation text.
- Drizzle migrations may only target `personal_ai_assistant` and must run the connection guard first.
- Keep task outcomes and subjective feedback independent. Do not auto-generate a cyber diary without a review-page message.
