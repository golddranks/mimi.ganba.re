// Service worker for Web Push reminders. Registered by reminders.js and served
// from the site root as /sw.js (so its scope is the whole origin). Two jobs:
//   - 'push': show the reminder. The cron sends payloadless pushes (no RFC 8291
//     encryption), so the text is fixed here; if a payload is ever sent, use it.
//   - 'notificationclick': focus an open tab, or open the app.
self.addEventListener("push", (event) => {
  let body = "Time to train! Don't break your streak.";
  try { if (event.data) body = event.data.text() || body; } catch { /* payloadless */ }
  event.waitUntil(self.registration.showNotification("mimi.ganba.re", {
    body,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: "mimi-reminder",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of open) if ("focus" in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow("/");
  })());
});
