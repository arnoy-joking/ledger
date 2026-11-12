self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() || "Someone you follow reached the top." };
  }

  event.waitUntil(self.registration.showNotification(data.title || "Ledger", {
    body: data.body || "Someone you follow reached the top.",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url || "/";
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin) return;

  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      existing.navigate(url.href);
      return existing.focus();
    }
    return clients.openWindow(url.href);
  }));
});
