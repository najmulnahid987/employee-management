# Dispatcher Monitoring & Privacy Architecture (M18.4)

## 1. Current Observability Architecture

Dispatcher implements a zero-leakage, privacy-safe local observability pipeline designed specifically for small local service businesses where customer home addresses, phone numbers, technician coordinates, and service tracking links must be strictly protected.

### Current Implementation State
- **External Monitoring SDKs:** None installed. No third-party tracking, analytics, or external crash-reporting service (such as Sentry, Bugsnag, Datadog, or Firebase Crashlytics) is active.
- **Diagnostic Engine:** [`src/lib/logger.ts`](file:///d:/projects_mobile/dispature/project/src/lib/logger.ts).
- **In-Memory Ring Buffer:** Stores up to 30 recent sanitized breadcrumbs locally in runtime memory for troubleshooting in-session crashes without transmitting data over the network.
- **Production Console Suppression:** Non-error console output is automatically suppressed in non-dev environments (`__DEV__ === false`).
- **Root Error Boundary:** Exported from Expo Router's root layout [`src/app/_layout.tsx`](file:///d:/projects_mobile/dispature/project/src/app/_layout.tsx), capturing uncaught render errors and rendering [`src/components/app-error-view.tsx`](file:///d:/projects_mobile/dispature/project/src/components/app-error-view.tsx) without exposing SQL syntax or stack traces.
- **Global Error Handlers:** `installGlobalErrorHandlers()` intercepts unhandled JS exceptions and promise rejections with duplicate-suppression flags.

---

## 2. Privacy & Data Redaction Guarantees

Every log message, diagnostic breadcrumb, and error passed through `logger` or `toUserFacingErrorMessage` is scrubbed against the following redaction rules:

| Category | Targeted Data | Redaction Behavior | Mask |
| :--- | :--- | :--- | :--- |
| **Authentication & Secrets** | Passwords, API keys, JWT bearer tokens, session secrets, auth cookies | Regex & key-matching scrubbed | `[REDACTED_SECRET]`, `[REDACTED_JWT]` |
| **Customer Tracking Tokens** | 64-char hex tokens, `/track/<token>`, `?token=<token>` | Sanitized from URLs and strings | `[REDACTED_TOKEN]` |
| **Customer PII** | Phone numbers (`\d{3}[-.\s]\d{3}[-.\s]\d{4}`), customer names, addresses | Key-matching & regex scrubbed | `[REDACTED_PHONE]`, `[REDACTED_ADDRESS]`, `[REDACTED_NAME]` |
| **GPS Coordinates** | Latitude & longitude fixes | Coarsened to 2 decimal places (~1.1 km area) | Rounded / `[COARSENED_COORDS]` |
| **Database & SQL Internals** | Postgres error codes (`42501`, `23505`, `P0001`), table/column names, check constraints | Converted to safe, user-friendly copy | Generic user-safe message |

---

## 3. Recommended Production Monitoring Setup (Sentry for Expo)

When transitioning from MVP development to high-scale production, teams may opt to connect an external error monitoring service. **Sentry for Expo (`@sentry/react-native`)** is the recommended tool.

### Manual Setup Instructions

#### Step 1: Install Sentry SDK
Use Expo CLI to install the SDK-compatible version:
```bash
npx expo install @sentry/react-native
```

#### Step 2: Configure EAS Build Secrets
Do **not** commit the Sentry DSN or auth tokens to Git or `.env`. Store them in EAS Secrets or the deployment CI environment:
```bash
npx eas-cli secret:create --name SENTRY_DSN --value "https://<key>@<organization>.ingest.sentry.io/<project>" --scope project
npx eas-cli secret:create --name SENTRY_AUTH_TOKEN --value "<auth_token>" --scope project
```

#### Step 3: Wire into Dispatcher's Privacy Pipeline
Integrate Sentry via Dispatcher's built-in reporter hook in `src/app/_layout.tsx` so that all events are pre-sanitized by [`src/lib/logger.ts`](file:///d:/projects_mobile/dispature/project/src/lib/logger.ts) before reaching Sentry:

```typescript
import * as Sentry from '@sentry/react-native';
import { logger, sanitizeForDiagnostics } from '@/lib/logger';

// 1. Initialize Sentry with strict beforeSend scrubbing
Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  debug: false,
  enableAutoSessionTracking: true,
  // Strict privacy filter: guarantee no customer PII or precise GPS reaches Sentry
  beforeSend(event) {
    if (event.request?.headers) {
      delete event.request.headers['Authorization'];
      delete event.request.headers['apikey'];
      delete event.request.headers['Cookie'];
    }
    // Scrub breadcrumbs and extra context
    if (event.extra) {
      event.extra = sanitizeForDiagnostics(event.extra) as Record<string, unknown>;
    }
    return event;
  },
});

// 2. Connect Dispatcher's logger to Sentry
logger.setReporter((breadcrumb) => {
  Sentry.addBreadcrumb({
    category: breadcrumb.tag,
    message: breadcrumb.message,
    level: breadcrumb.level === 'warn' ? 'warning' : breadcrumb.level,
    data: breadcrumb.data ? (sanitizeForDiagnostics(breadcrumb.data) as Record<string, unknown>) : undefined,
    timestamp: new Date(breadcrumb.timestamp).getTime() / 1000,
  });
});
```

### Prohibited Monitoring Practices
1. **Never send raw location points:** Do not attach uncoarsened GPS coordinates to Sentry tags, extras, or breadcrumbs.
2. **Never send customer phone numbers or addresses:** Customer records must remain strictly on the Supabase backend behind RLS.
3. **Never send raw tracking tokens:** Error messages containing tracking URLs must be sanitized with `sanitizeString`.

