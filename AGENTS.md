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
- **Strictly Excluded (No Scope Creep):** AI scheduling, payroll/wages, invoicing/payments, inventory/parts, CRM, automated route optimization, native customer mobile app, multi-worker assignment, multi-business tenancy, automated SMS messaging / Twilio integration (Phase M14 DEFERRED: customer tracking relies exclusively on manual link copying and native sharing).
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

## Project Roadmap & Milestone Status
- **Phase M0:** Frozen Baseline Specification & Architecture — **COMPLETE**
- **Phase M1:** Design System Tokens & Base UI Components — **COMPLETE**
- **Phase M2:** Shared Authentication & Onboarding UI — **COMPLETE**
- **Phase M3:** Core Screen Layouts (16 Mobile Screens) — **COMPLETE**
- **Phase M4:** PostgreSQL Schema, Relational Integrity & RLS Security — **COMPLETE**
- **Phase M5:** Supabase Authentication & Session Management — **COMPLETE**
- **Phase M6:** Owner Business Setup & Worker Team Management — **COMPLETE**
- **Phase M7:** Owner Job Creation & Single-Worker Assignment — **COMPLETE**
- **Phase M8:** Worker Job Execution & Sequential Status Transitions — **COMPLETE**
- **Phase M9:** Lifecycle Concurrency, Idempotency & Terminal Locking — **COMPLETE**
- **Phase M10:** Realtime Event Subscriptions & Socket Reconnection — **COMPLETE**
- **Phase M11:** Worker Background Location Tracking & Breadcrumbs — **COMPLETE**
- **Phase M12:** Owner Live Map & Realtime Territory Visualization — **COMPLETE**
- **Phase M13:** Public Customer Tracking Web Page, Tokenized Sessions & Sharing — **COMPLETE**
- **Phase M14 (SMS with Twilio):** Automated SMS dispatch & carrier messaging — **DEFERRED**
  - *Status:* Intentionally deferred. Do not implement SMS or automated messaging.
  - *Rules:* Do not install Twilio packages or add SMS integrations; do not add Twilio credentials, environment variables, webhooks, or SMS-related database changes.
  - *Workflow:* Preserve the existing customer tracking-link functionality and manual copy/share workflow (`expo-clipboard` and native `Share.share`).
  - *Sequencing:* Continue with the next planned phase without renumbering existing phases or introducing SMS as a dependency.
- **Phase M15:** Billing Readiness & Stripe Subscriptions Integration — **PLANNED**

## M4 Security & Authorization Architecture

### 1. Role-Based Table Permissions
- **`businesses`**:
  - `anon`: Revoked (no SELECT, INSERT, UPDATE, DELETE).
  - `owner`: SELECT own business (`id = app_auth.current_business_id()`); UPDATE non-relational business metadata (`name`, `phone`, `address`). INSERT/DELETE denied (creation via RPC).
  - `worker`: SELECT own business; INSERT, UPDATE, DELETE denied.
  - `service_role`: Full bypass.
- **`profiles`**:
  - `anon`: Revoked.
  - `owner`: SELECT own profile and active/inactive workers in same business (`business_id = app_auth.current_business_id()`); UPDATE own profile and worker `is_active` status (`role` and `business_id` locked). INSERT/DELETE denied.
  - `worker`: SELECT own profile and business owner profile for team contact; UPDATE own contact info (`full_name`, `phone`, `avatar_url`; `role`, `business_id`, `is_active` locked). INSERT/DELETE denied.
  - `service_role`: Full bypass.
- **`jobs`**:
  - `anon`: Revoked (no direct table access; customer tracking via RPC `get_customer_tracking_job`).
  - `owner`: SELECT all jobs in own business; INSERT unassigned jobs in own business (`status = 'unassigned'`, `worker_id IS NULL`); UPDATE jobs in own business (non-terminal); DELETE revoked.
  - `worker`: SELECT assigned jobs only (`worker_id = auth.uid()`); UPDATE assigned jobs only for permitted sequential status transitions or assignment decline (`assigned` -> `unassigned`). Customer/address/schedule fields locked. INSERT/DELETE denied.
  - `service_role`: Full bypass.
- **`job_events`**:
  - `anon`: Revoked.
  - `owner`: SELECT events in own business; INSERT, UPDATE, DELETE revoked.
  - `worker`: SELECT events for assigned jobs; INSERT, UPDATE, DELETE revoked.
  - `service_role`: Full bypass (client writes revoked; trigger-generated only).
- **`locations`**:
  - `anon`: Revoked.
  - `owner`: SELECT locations of workers in own business; INSERT, UPDATE, DELETE revoked.
  - `worker`: SELECT own locations (`worker_id = auth.uid()`); INSERT own locations for assigned active jobs (or ambient with `job_id IS NULL`); UPDATE, DELETE revoked.
  - `service_role`: Full bypass.
- **`subscriptions`**:
  - `anon`: Revoked.
  - `owner`: SELECT own business subscription; INSERT, UPDATE, DELETE revoked.
  - `worker`: Denied (no access).
  - `service_role`: Full bypass (managed exclusively by server-side webhooks).

### 2. Business Isolation & Trusted Identity
- **Trusted Identity:** `auth.uid()` from verified JWT claims. Never trust client-provided `business_id`, `role`, or `actor_id`.
- **Private Helper Schema (`app_auth`):** Non-recursive `SECURITY DEFINER` functions (`current_business_id()`, `current_user_role()`, `is_business_owner()`, `is_active_worker()`) with `SET search_path = ''`.
- **Relational Integrity Guarantees:** Composite unique key `profiles(id, business_id)` and composite foreign key `jobs(worker_id, business_id) REFERENCES profiles(id, business_id)` guarantee workers can never be assigned to jobs outside their business.

### 3. Protected Job Assignment & Lifecycle Operations
- **Lifecycle Transition Trigger:** `trg_jobs_validate_lifecycle_transition` enforces the frozen 8 statuses:
  `unassigned` -> `assigned` -> `accepted` -> `on_the_way` -> `arrived` -> `in_progress` -> `completed` (terminal) | `cancelled` (terminal).
- **Enforcement Rules:** Workers can only advance sequential statuses or decline (`assigned` -> `unassigned`). Only Owners can assign workers (`unassigned` -> `assigned`, reassignment, unassign) or cancel jobs (with mandatory `cancellation_reason`). Terminal statuses (`completed`, `cancelled`) are immutable and cannot be reopened.
- **Transactional RPCs:** `assign_job_worker`, `cancel_job`, `advance_job_status`, `decline_job_assignment`.

### 4. Audit-Event Generation Strategy
- **Trigger-Driven Immutability:** `handle_job_event_logging()` runs `AFTER INSERT OR UPDATE ON jobs` as `SECURITY DEFINER` with empty `search_path`.
- Direct client `INSERT`, `UPDATE`, `DELETE` on `job_events` are revoked; `trg_prevent_job_events_mutation` blocks mutations.
- Automatically captures actor ID, role (`owner`, `worker`, `system`), event type, previous/new status, and metadata atomically within the transaction.

### 5. Location-Write Restrictions
- Workers can only insert locations where `worker_id = auth.uid()` and `job_id` references an active job assigned to them.
- Direct `UPDATE` and `DELETE` on `locations` are revoked; `trg_prevent_locations_mutation` prevents modification of historical breadcrumbs.

### 6. Customer Tracking Security & Token Design
- Raw tables have zero public SELECT access (`REVOKE ALL ON jobs FROM anon`).
- Tracking token is an opaque 128-bit UUIDv4 (`gen_random_uuid()`) with 122 bits of entropy; never guessable from job ID.
- Access via `get_customer_tracking_job(p_tracking_token)` returns an allowlisted JSON payload (status, label, service, business name/phone, worker first name and avatar).
- Withholds customer phone, internal notes, gate codes, cancellation reason, worker contact details, and location history. Returns generic `NULL` on invalid tokens (anti-enumeration).

### 7. Server-Side Credential Hygiene
- **Service-Role Key (`SUPABASE_SERVICE_ROLE_KEY`):** Must NEVER be included in the mobile app, public tracking frontend, or client `.env` files. Bypasses all RLS.
- **Database Passwords / Connection Strings:** Strictly server-side for migrations/backend.
- **Stripe Secret / Webhook Keys:** Strictly server-side in Edge Functions / billing backends.
- **Client Safe Keys:** Mobile app and tracking frontend strictly use `EXPO_PUBLIC_SUPABASE_ANON_KEY`.

### 8. Database Security Test Execution
- Requires Supabase CLI and local Docker/Podman:
  ```bash
  npx supabase start
  npx supabase test db
  ```
- 8 test files in `supabase/tests/` covering 71 pgTAP test assertions.

### 9. Test Verification Status
- **Static & Syntax Validation:** All 71 assertions across 8 test suites pass review and align with PostgreSQL 15/16 and pgTAP specifications.
- **Live Test Blocker:** Local execution requires Docker Desktop/Podman, which is currently unavailable on the local Windows environment.
- **Safety Directive:** Tests must NEVER be run against the remote/production project (`liuwoncaagppyezxugtt`).
- **Production Disclaimer:** Development and static test verification does NOT constitute proof of production security. Live penetration audits and CI verification with Docker are required prior to production launch.

### 10. Phase Limitations & Prerequisites
- **Auth Phase:** Connect Supabase Auth (`signUp`, `signInWithPassword`) with secure token storage (`expo-secure-store`) and wire worker invitation join tokens.
- **Customer Tracking Phase:** Implement dedicated customer web frontend and configure CDN reverse-proxy rate limiting (60 req/min/IP).
- **Twilio SMS Phase (Phase M14):** DEFERRED. No automated SMS or Twilio integration. Preserve manual copy/share workflow.
- **Billing Phase:** Deploy Supabase Edge Functions with `STRIPE_WEBHOOK_SECRET` to update `subscriptions`.

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
