// ── SargTech Expenses - Service Worker for Mobile Push Notifications ──
self.addEventListener('push', function(event) {
    let data = { title: 'SargTech Expenses', body: 'You have a new expense notification.' };
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: '/images/favicon.png',
        badge: '/images/favicon.png',
        vibrate: [100, 50, 100],
        data: {
            url: data.url || '/dashboard'
        }
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const targetUrl = event.notification.data ? event.notification.data.url : '/dashboard';
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(function(clientList) {
            for (let i = 0; i < clientList.length; i++) {
                let client = clientList[i];
                if (client.url.includes(targetUrl) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
