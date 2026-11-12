# Push notifications setup

This is an opt-in add-on. The same profile UI is available to existing and newly created accounts; each person must explicitly allow browser notifications and choose which people to follow. The browser permission prompt is shown only after a tap.

## 1. Add the database objects

In the Supabase SQL Editor, run [`notifications.sql`](./notifications.sql). It only adds new tables, RLS policies, and a private snapshot RPC. It does not alter or delete Ledger's existing rows or tables. The SQL is safe to re-run.

## 2. Configure and deploy the Edge Function

Generate a VAPID key pair (keep the private key in Supabase Secrets, never in the app code):

```sh
npx --yes web-push generate-vapid-keys
```

In Edge Function **Secrets**, add:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (for example `mailto:you@example.com`)

Supabase provides `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY` to Edge Functions. The function validates the signed-in user itself, so deploy with JWT gateway verification disabled. In the dashboard, turn off **Verify JWT with legacy secret** for this function; with the CLI, use:

```sh
supabase functions deploy ledger-push-score-change --no-verify-jwt
```

The function's code still checks every request against Supabase Auth. Its service-role key and VAPID private key stay server-side.

## 3. Test on Android Chrome

Deploy Ledger over HTTPS, sign in on Chrome for Android, open another person's profile, tap **Turn on**, allow notifications, then tap **Notify me**. Add or update a score that moves that person into first place. The app calls the Edge Function after score saves; no Database Webhook or extra database trigger is needed. Push can arrive while the page is closed, subject to Android and Chrome settings.

The first check for a leaderboard establishes a baseline rather than sending an old alert about someone who was already leading. A later change of #1 sends notifications to users who opted in for that person. The service worker is [`../sw.js`](../sw.js).

No push permission is requested automatically during sign-up; browsers require a clear user gesture and consent.

## Disable / revert

The feature can be disabled by removing the notification UI/function or by undeploying the Edge Function. The SQL objects are additive; nothing in the setup drops existing tables or rows. The code changes are isolated to the notification UI, `sw.js`, and the `supabase/` files and can be reverted independently.
