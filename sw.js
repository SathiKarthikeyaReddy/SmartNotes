self.addEventListener('push', event => {
  let data={};
  try {data=event.data?.json() || {};}catch { /* Deliver a generic alert when a payload is malformed. */ }
  event.waitUntil(self.registration.showNotification(data.title || 'SmartNotes reminder', {body:data.body,tag:data.id,data:{url:'/'},requireInteraction:true}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows => {
    const existing=windows.find(w=>new URL(w.url).origin===self.location.origin);
    if(existing) return existing.focus();
    return clients.openWindow('/');
  }));
});
