# Dispatcher Project Rules

## Source of Truth
The authoritative, frozen specification for this project is [`docs/product-specification.md`](docs/product-specification.md). All application screens, lifecycle states, roles, permissions, data models, and scope boundaries must strictly align with this document. Do not create duplicate source-of-truth documents.

## Product
Dispatcher is a mobile-first dispatch and job-execution system for small local service businesses. Owners create, assign, and track jobs; workers accept and complete jobs in the field; customers track their service visit via a secure web tracking link.

## Roles & Interfaces
- **Owner (Mobile App):** Manages the business, workers, jobs, assignments, cancellations, and operational visibility across 5 root tabs (`Dashboard`, `Jobs`, `Workers`, `Live Map`, `Profile`).
- **Worker (Mobile App):** Field technician viewing assigned work and executing permitted sequential status transitions across 3 root tabs (`Today`, `Jobs`, `Profile`).
- **Customer (Web Browser):** Service recipient viewing live status updates via a non-guessable, tokenized tracking link without requiring an account or mobile app.

## Stack
- React Native
- Expo
- TypeScript
- Expo Router
- Supabase and PostgreSQL in later phases

## Frozen Job Lifecycle (8 Statuses)
- `unassigned`
- `assigned`
- `accepted`
- `on_the_way`
- `arrived`
- `in_progress`
- `completed` (terminal)
- `cancelled` (terminal)

### Lifecycle Rules & Transitions
- **Allowed transitions:**
  - `unassigned` → `assigned`: Owner assigns a valid worker from the same business.
  - `assigned` → `accepted`: Assigned worker accepts assignment.
  - `assigned` → `unassigned`: Assigned worker declines before acceptance, OR Owner unassigns the job.
  - `accepted` → `on_the_way`: Assigned worker starts travelling.
  - `on_the_way` → `arrived`: Assigned worker records arrival.
  - `arrived` → `in_progress`: Assigned worker starts work.
  - `in_progress` → `completed`: Assigned worker completes work.
  - Nonterminal (`unassigned`, `assigned`, `accepted`, `on_the_way`, `arrived`, `in_progress`) → `cancelled`: Owner cancels with a mandatory cancellation reason.
- **Terminal statuses:** `completed` and `cancelled` are terminal in the MVP; reopening terminal jobs is not supported.
- **Declining is an event:** Declining an assignment transitions `assigned` → `unassigned`; do not invent an additional job status.
- **Transition validation:** Invalid transitions must be rejected. Each successful status change produces an append-only, server-recorded job event (`actor`, `previous_status`, `new_status`, `timestamp`, `metadata`).

## Frozen Mobile Screens (16 Screens + Customer Web Page)
1. Sign In (Shared Auth)
2. Owner Business Setup (Onboarding)
3. Worker Invitation / Join (Onboarding)
4. Owner Dashboard (Owner Tab Root 1)
5. Owner Jobs (Owner Tab Root 2)
6. Create Job (Modal / Stack)
7. Owner Job Details (Stack)
8. Assign Worker (Modal / Stack)
9. Workers (Owner Tab Root 3)
10. Worker Details (Stack)
11. Live Map (Owner Tab Root 4)
12. Owner Profile / Business Settings (Owner Tab Root 5)
13. Worker Today (Worker Tab Root 1)
14. Worker Jobs (Worker Tab Root 2)
15. Worker Job Details (Stack)
16. Worker Profile (Worker Tab Root 3)
*Customer Tracking Web Page is documented separately as an unauthenticated web surface.*

## Explicit MVP Scope Boundaries
- **In-Scope:** Job creation, single-worker assignment, execution, status visibility, append-only history, customer link-based tracking, native communication launchers (call/map), basic billing readiness fields.
- **Strictly Excluded (No Scope Creep):** AI scheduling, payroll/wages, invoicing/payments, inventory/parts, CRM, automated route optimization, native customer mobile app, multi-worker assignment, multi-business tenancy.
- Future-phase features mentioned for readiness are not considered implemented.

## Core Engineering & Architecture Rules
- **No Scope Creep:** Strictly build only features documented in the frozen MVP specification.
- **Strict Business Tenancy:** Every job belongs to exactly one business. Business data must be isolated between businesses.
- **Single Worker Assignment:** A job has at most one currently assigned worker, who must belong to the same business.
- **No Fake Business Data:** Never invent mock datasets that violate relational integrity, single-business tenancy, or lifecycle transitions.
- **No Unauthorized Status Changes:** Reject invalid transitions. Server-side validation and RLS enforcement are mandatory; client checks alone are insufficient.
- **No Insecure Secrets:** Never include service-role keys, database passwords, or server secrets in mobile code or repo.
- **No Undocumented Tables:** Never create database tables, columns, or relations without documentation in the product specification.
- **No Unreviewed Schema Changes:** All database schema changes must be documented and executed through reviewed migrations in `supabase/migrations/`.
- **Append-Only History:** Status history is strictly append-only from the application perspective.
- **Inspect existing code before editing.**
- **Keep changes small and incremental.** Reuse components.
- **Keep UI, business logic, and backend access separated.**
- **Use TypeScript correctly.**
- **Preserve the current Expo Router architecture.**
- **Never claim a test passed unless it actually ran.**
- **Report which files changed and what checks were executed.**

## Design
- Minimal professional B2B interface
- Black primary actions
- White and off-white backgrounds
- Neutral text and borders
- Soft status colors
- Large touch targets
- One obvious primary action per screen

## AI workflow
- Gemini should implement routine tasks one at a time.
- Do not generate the entire application in one prompt.
- Do not add dependencies unless needed for the current task.
- Do not build product features during Phase 1.
- Run the relevant checks after every change.

---

# Expo & React Native Guidelines

This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
