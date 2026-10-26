/* Service worker só de push: sem fetch, sem cache offline. */
const FALLBACK_URL = "/portal";
const ICON = "/brand/rainha-cred/icones/icone-fundo-branco-192.png";

function safeUrl(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\") ? url : FALLBACK_URL;
}

// Defesa extra: o alvo final precisa ser do próprio site, mesmo que safeUrl deixe passar algo estranho.
function clickTarget(url) {
  const target = new URL(safeUrl(url), self.location.origin);
  return target.origin === self.location.origin ? target.href : new URL(FALLBACK_URL, self.location.origin).href;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Rainha Cred";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === "string" ? payload.body : "",
      icon: ICON,
      data: { url: safeUrl(payload.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = clickTarget(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open && "navigate" in open) return open.focus().then(() => open.navigate(target));
      return self.clients.openWindow(target);
    }),
  );
});
