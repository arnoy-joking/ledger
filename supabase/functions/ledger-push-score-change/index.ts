import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const appKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");

  if (!url || !publicKey || !appKey) {
    return json({ error: "Push notifications are not configured on Supabase yet." }, 503);
  }

  // JWT gateway verification is disabled so both the app and server can call
  // this function; each request is still checked against Supabase Auth here.
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Sign in to continue." }, 401);
  const userClient = createClient(url, appKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Sign in to continue." }, 401);

  // The public VAPID key is safe for the browser; the private key stays in
  // Supabase Edge Function secrets.
  if (request.method === "GET") return json({ vapidPublicKey: publicKey });
  if (!serviceKey || !privateKey) return json({ error: "Push delivery is not configured on Supabase yet." }, 503);

  let payload: { day?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  if (!isDay(payload.day)) return json({ error: "A valid YYYY-MM-DD day is required." }, 400);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Called by Ledger after a signed-in user saves a score. The RPC remains the
  // source of truth for both leaderboard views; clients cannot provide scores.
  const { data: rows, error: scoreError } = await admin.rpc("ledger_scores", { d: payload.day });
  if (scoreError) {
    console.error("ledger_scores failed", scoreError);
    return json({ error: "Could not check the leaderboard." }, 500);
  }
  if (!Array.isArray(rows)) return json({ error: "Unexpected leaderboard response." }, 500);

  const topIds = (field: "d_points" | "t_points") => {
    const values = rows.map((row) => Number(row[field] ?? 0)).filter(Number.isFinite);
    const maximum = Math.max(0, ...values);
    if (maximum <= 0) return [];
    return rows
      .filter((row) => Number(row[field] ?? 0) === maximum && typeof row.id === "string")
      .map((row) => row.id as string);
  };

  const boardChanges = [
    { key: `day:${payload.day}`, label: `the daily board (${payload.day})`, leaders: topIds("d_points") },
    { key: "overall", label: "the overall board", leaders: topIds("t_points") },
  ];
  const newLeaderAlerts: Array<{ id: string; label: string }> = [];

  for (const board of boardChanges) {
    const { data: previous, error: snapshotError } = await admin.rpc(
      "ledger_take_notification_snapshot",
      { p_board_key: board.key, p_top_user_ids: board.leaders },
    );
    if (snapshotError) {
      console.error("leader snapshot failed", snapshotError);
      return json({ error: "Could not update the notification snapshot." }, 500);
    }
    // First check is a baseline; it avoids stale alerts for someone already #1.
    if (previous === null) continue;
    const priorIds = new Set(Array.isArray(previous) ? previous : []);
    for (const id of board.leaders) {
      if (!priorIds.has(id)) newLeaderAlerts.push({ id, label: board.label });
    }
  }

  if (!newLeaderAlerts.length) return json({ sent: 0 });

  const leaderIds = [...new Set(newLeaderAlerts.map((item) => item.id))];
  const [{ data: profiles, error: profilesError }, { data: follows, error: followsError }] = await Promise.all([
    admin.from("profiles").select("id,username").in("id", leaderIds),
    admin.from("notification_follows").select("subscriber_id,followed_user_id").in("followed_user_id", leaderIds),
  ]);
  if (profilesError || followsError) {
    console.error("notification recipients lookup failed", profilesError ?? followsError);
    return json({ error: "Could not load notification recipients." }, 500);
  }
  if (!follows?.length) return json({ sent: 0 });

  const names = new Map((profiles ?? []).map((profile) => [profile.id, profile.username]));
  const alertsBySubscriber = new Map<string, Map<string, Set<string>>>();
  for (const follow of follows) {
    const perLeader = alertsBySubscriber.get(follow.subscriber_id) ?? new Map<string, Set<string>>();
    const periods = perLeader.get(follow.followed_user_id) ?? new Set<string>();
    for (const alert of newLeaderAlerts) {
      if (alert.id === follow.followed_user_id) periods.add(alert.label);
    }
    perLeader.set(follow.followed_user_id, periods);
    alertsBySubscriber.set(follow.subscriber_id, perLeader);
  }

  const subscriberIds = [...alertsBySubscriber.keys()];
  const { data: subscriptions, error: subscriptionError } = await admin
    .from("push_subscriptions")
    .select("user_id,endpoint,subscription")
    .in("user_id", subscriberIds);
  if (subscriptionError) {
    console.error("push subscriptions lookup failed", subscriptionError);
    return json({ error: "Could not load push subscriptions." }, 500);
  }
  if (!subscriptions?.length) return json({ sent: 0 });

  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") ?? "mailto:notifications@example.com",
    publicKey,
    privateKey,
  );
  let sent = 0;
  await Promise.all(subscriptions.map(async (record) => {
    const personAlerts = alertsBySubscriber.get(record.user_id);
    if (!personAlerts) return;
    const details: string[] = [];
    for (const [leaderId, periods] of personAlerts) {
      const name = names.get(leaderId) || "Someone you follow";
      for (const period of periods) details.push(`${name} reached #1 on ${period}`);
    }
    if (!details.length) return;

    const firstLeaderId = personAlerts.keys().next().value as string | undefined;
    try {
      await webpush.sendNotification(record.subscription, JSON.stringify({
        title: "Ledger leaderboard",
        body: details.join(". "),
        url: `/#u-${firstLeaderId ?? leaderIds[0]}`,
      }));
      sent++;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await admin.from("push_subscriptions").delete()
          .eq("user_id", record.user_id)
          .eq("endpoint", record.endpoint);
      } else {
        console.error("push delivery failed", error);
      }
    }
  }));

  return json({ sent });
});
