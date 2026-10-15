# Pocket Accountant (Sorrel)

An AI-assisted personal finance advisor — real bank data in, plain-language advice out, nothing acted on without an explicit yes. Built as a personal/household tool, not a multi-tenant product.

## Overview

Most budgeting apps show you a dashboard and leave the interpreting to you. Pocket Accountant tries to behave more like an actual advisor: it links real bank accounts, watches spending and goals over time, and proactively tells the user what matters right now — a category running hot, a subscription creeping up in price, a goal falling behind pace — in plain sentences, with the real numbers behind the claim.

The one rule that shapes almost everything else in this codebase: **the AI never moves money and never does the arithmetic.** Every dollar figure a user sees was computed by deterministic code and can be traced back to a real transaction; Claude's job is narration, categorization, and judgment calls over numbers it's handed, never invention. Anything that changes a budget, a goal, or an account is proposed, explained, and requires an explicit tap to apply.

## Features

- **AI-generated budgets with a hard income floor.** Claude proposes per-category amounts from real spending history; deterministic code then enforces that the total can never silently exceed real income — discretionary categories absorb the squeeze first, down to a floor, and only drop further with an explicit, informed user decision (never automatically).
- **Financial Advisor Agent.** A bounded Claude tool-use loop that investigates already-computed signals (budget alerts, goal pace, subscription price creep, account balances) and decides what's most worth telling the user about right now — every tool it calls returns a number an existing deterministic function already computed; the agent never reimplements financial math.
- **Goal tracking backed by real linked accounts** — multiple concurrent goals, each balance-tracked against a real account rather than inferred from net cash flow, with historical-pace reconstruction so "when could I actually afford this" stays grounded in real transaction history.
- **"Can I afford this?" chat** — a conversational, tool-using AI flow over a deterministic what-if engine (financing terms, trade-ins, down payments), so a hypothetical stays numerically consistent across follow-up questions instead of drifting.
- **Recurring bill & subscription audit** — detects recurring charges from real transaction history, flags gradual price creep and one-time jumps, and feeds a real "known committed bills" floor into the budget (a 90-day average can understate what's actually owed).
- **Net worth tracking** across linked checking/savings/investment/retirement accounts.
- **Gmail receipt scanning** (optional) — line-item extraction from real receipt emails, with an explicit relink signal if Google access is ever revoked rather than silently going stale.
- **Decision history** — every AI recommendation the user accepted or rejected is logged in plain language, not just the outcome.
- **Security**: biometric app lock, session timeout, two-factor authentication, and a real user-linked Plaid Production account (not a Sandbox demo).

## AI / Advisor architecture

Two distinct AI call patterns, both wrapped in the same non-negotiable rule (propose and explain, never silently act):

1. **Narrow, single-purpose calls** — categorizing a transaction, drafting a budget's per-category amounts, narrating why a category is over, extracting line items from a receipt. Each of these hands Claude a tightly-scoped prompt and a JSON response contract; the response is validated, clamped, and in several cases (budget totals, discretionary spending) mechanically corrected by deterministic code before it's ever shown to the user or written to the database.
2. **The Financial Advisor Agent** — a small, bounded tool-use loop (max 3 rounds, the last round removes tool access entirely so it's structurally forced to answer) that reads a short list of already-detected conditions and decides which one is most worth surfacing, optionally calling read-only tools to investigate further. Every tool is a thin wrapper around an existing, already-tested function (`getBudgetInsight`, `getGoalsProgress`, `getIncomeSummary`, etc.) — the agent's only real output is prioritization and plain-language explanation, never a new number.

Both patterns share one enforcement layer: nothing either produces is ever auto-applied. A proposed budget, a suggested category cut, a recommended re-balance — all of it is shown with its reasoning and requires an explicit tap before anything is written.

## Technical architecture

| Layer | Choice | Notes |
|---|---|---|
| Mobile client | React Native + Expo Router | Plain JavaScript, not TypeScript. File-based routing under `app/app/`. |
| Backend | Node.js + Express | Plain JavaScript (CommonJS). One process, no microservices. |
| Database & auth | Supabase (Postgres + Auth) | Row-Level Security enforced at the database layer as a backstop under the backend's own per-user filtering. |
| Bank data | Plaid | Real Production API data via Plaid's free Trial plan (auto-approved, up to 10 linked accounts) — not Sandbox test data. |
| AI | Anthropic Claude (Haiku) | See "AI / Advisor architecture" above. |
| Push notifications | Expo push + Firebase Cloud Messaging | Android only in current testing. |
| Tests | Node's built-in `node --test` (backend only) | No test framework dependency — see "Status" below on client-side coverage. |

No TypeScript, no GraphQL, no separate state-management library (plain React state + Context), no microservices, no message queue. The complexity in this app is in the financial logic and the AI-guardrail discipline, not the plumbing.

## Project structure

```
app/                    React Native / Expo Router client
  app/                  Screens (file-based routing) + shared code
    (tabs)/             Home, Budget, Goal, Recurring, Account tabs
    settings/           Settings sub-screens
    _components/        Shared UI components
    _lib/                Shared client-side logic (API client, theming, formatting)
server/                 Express backend
  index.js              All HTTP routes
  *.js                  One module per domain (budget.js, goalFunding.js, scenario.js, advisorAgent.js, ...)
  test/                 node:test suite
supabase/
  migrations/           Every schema change, in order
infra/                  AWS deploy scripts/configs (systemd unit, Caddyfile, deploy script)
```

## Getting started

### Accounts & API keys you'll need

Each of these is a service you sign up for yourself and get your own credentials from — this repo never ships real values, only `.env.example` files showing what's expected.

| Service | Where to get it | Used for |
|---|---|---|
| **Supabase** | [supabase.com](https://supabase.com) → your project → Project Settings → API | Auth + Postgres database. You'll need the project URL, the `anon` key (client-safe), and the `service_role` key (server-only, never expose to the app). |
| **Plaid** | [dashboard.plaid.com](https://dashboard.plaid.com) → Developers → Keys | Bank account linking and transaction sync. Runs on Plaid's **Trial plan** — real Production API, free, auto-approved, up to 10 linked accounts. |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) → API Keys | Claude Haiku — transaction categorization, budget generation, re-balance proposals, receipt extraction, the Advisor Agent. This project deliberately runs a low monthly spend cap (Settings → Billing) — worth setting your own. |
| **Google Cloud Console** | [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials | An OAuth client for the *optional* Gmail receipt-scanning link. Requires the Gmail API enabled and this backend's `/auth/google/callback` URL added as an authorized redirect URI. This is **separate** from Google Sign-In (below). |
| **Google Sign-In (via Supabase)** | Supabase Dashboard → Authentication → Providers → Google | One of the app's two sign-in methods (the other is a plain username/password, also backed by Supabase Auth). This is a *different* Google OAuth client, configured directly in Supabase's dashboard, not in this repo's `.env` files. |
| **Firebase** | [console.firebase.google.com](https://console.firebase.google.com) | Android push notifications (Cloud Messaging). Needs a project with an Android app registered under package `com.curt182.pocketaccountant`, which produces `google-services.json` (already committed in `app/` — not a secret) and an **FCM V1 service account key** (a real secret, uploaded to EAS directly via `eas credentials`, never stored in this repo). |
| **Expo / EAS** | [expo.dev](https://expo.dev) account | Building the Android dev-client (`eas build`) and managing push credentials (`eas credentials`). Free tier is fine. |
| **ngrok** | [ngrok.com](https://ngrok.com) account + authtoken | Tunnels the local backend to a public HTTPS URL — required for Google OAuth redirects and for testing on a phone that isn't on the same network as the dev machine. |

### Tools to install

- **Node.js + npm**
- **Supabase CLI** — `brew install supabase/tap/supabase` (or via `npx`). Needed for database migrations (`supabase db push`); requires running `supabase login` and `supabase link` once (interactive, uses your own Supabase account).
- **ngrok CLI**
- **Expo CLI / EAS CLI** — used via `npx expo ...` / `npx eas-cli ...`, no global install needed.
- **Android platform tools (`adb`)** — `brew install android-platform-tools`. Needed to install the dev-client build on a physical device.
- **A physical Android device** for testing. Testing has been exclusively on a real Android device via a custom EAS dev-client build — Expo Go can't reliably complete this app's OAuth redirects on Android. iOS is untested (the data model supports it, but no iOS build has been made).
- **Git**

### Environment variables

See `server/.env.example` and `app/.env.example` for the full, current list with explanatory comments — never committed with real values. In brief: Supabase URL + anon key + service-role key, Plaid client ID + secret, an Anthropic API key, Google OAuth client credentials (Gmail link), and the backend/tunnel URLs both sides need to agree on.

### Setup

1. Clone the repo.
2. `cp server/.env.example server/.env` and `cp app/.env.example app/.env`, then fill in real values using the accounts above.
3. Add your email to `ALLOWED_EMAILS` in `server/.env` (comma-separated) — the backend rejects sign-in from any email not on this list, even with a valid Google session.
4. `cd server && npm install`, then `cd ../app && npm install`.
5. Run `supabase login` and `supabase link` (interactive) once, then `supabase db push` to apply migrations.

### Running locally

Three processes run simultaneously:

1. Backend: `cd server && node index.js`
2. ngrok tunnel to the backend: `ngrok http 3000` — the resulting URL has to match `EXPO_PUBLIC_API_URL` (app) and `BACKEND_URL` (server), **and** be registered as the Google OAuth redirect URI.
3. Metro in tunnel mode: `cd app && npx expo start --dev-client --tunnel`

A native rebuild (`eas build --profile development --platform android`) is only needed when a native module changes — plain JS changes hot-reload via Metro.

## Development

```bash
# Backend
cd server
npm test              # node:test — 490+ tests over the deterministic financial logic
npm run lint           # ESLint
npm run format:check   # Prettier

# Client
cd app
npm run lint            # ESLint (eslint-config-expo)
npm run format:check    # Prettier
```

CI (`.github/workflows/ci.yml`) runs the backend test suite plus lint/format checks on both `app/` and `server/` on every push and PR to `main`; a separate workflow (`deploy.yml`) auto-deploys the backend and web build to AWS once CI passes. Every user-facing change is also tap-tested on a real Android device before being considered done, not just verified against the API.

## Engineering notes

- **Plain JavaScript, deliberately.** No TypeScript on either side. The type-safety tradeoff is real, but the project's actual risk surface — AI responses that need runtime validation regardless of any static type, and financial math that needs behavior-locking tests, not type annotations — is better addressed by the validation/clamping code and the backend's test suite than a type layer would add on its own.
- **No test framework dependency on the backend.** `node --test` (built into Node) covers the pure financial logic directly — deterministic functions with fixed inputs, no live Anthropic or Supabase calls needed to run the suite.
- **The client has no automated tests.** Screens are verified by hand on a real device before anything is called done; this is a real gap, not an oversight, and is the most honest weak point in this repo's test coverage.
- **Deterministic guardrails around every AI call, verified by real bugs they caught.** The budget-generation pipeline in particular has produced two live, user-reported bugs where an AI-adjacent cap didn't engage in an edge case — both caught by code review and fixed with regression tests, not just patched.

## Status

Personal/household tool, not a public product — not on the App Store or Google Play, and not intended to be. Runs on real production financial data (Plaid's Trial plan, not Sandbox), currently supports one signed-in account per session (shared household access today means sharing that one login, not a multi-tenant permission model). Actively developed; the backend test suite and on-device tap-testing are the two quality gates in place, no CI yet.
