// Service worker for Web Push. Served at /sw.js (same origin as the app).
// Receives pushes sent by the IdP (id.kbn.one) with its VAPID key and shows
// a notification; clicking it focuses/opens the message URL.

const DEFAULT_TITLE = "home portal";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const parsePushData = (event) => {
  if (!event.data) return {};
  try {
    const json = event.data.json();
    return typeof json === "object" && json !== null ? json : {};
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
};

self.addEventListener("push", (event) => {
  const data = parsePushData(event);
  const title = typeof data.title === "string" && data.title.trim()
    ? data.title
    : DEFAULT_TITLE;
  const options = {
    body: typeof data.body === "string" ? data.body : undefined,
    icon: typeof data.icon === "string" ? data.icon : undefined,
    badge: typeof data.badge === "string" ? data.badge : undefined,
    tag: typeof data.tag === "string" ? data.tag : undefined,
    requireInteraction: Boolean(data.requireInteraction),
    data: {
      ...(typeof data.data === "object" && data.data ? data.data : {}),
      url: typeof data.url === "string" ? data.url : undefined,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (!url) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of clients) {
      if (client.url === url && "focus" in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
