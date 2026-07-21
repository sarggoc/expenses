// ── SargTech Expenses - Offline Mode & Auto-Sync Queue ──
(function() {
    const STORAGE_KEY = 'sargtech_offline_expenses';

    window.getOfflineQueue = function() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        } catch (e) {
            return [];
        }
    };

    window.saveOfflineQueue = function(queue) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
        window.updateOfflineBadge();
    };

    window.addExpenseToOfflineQueue = function(expenseData) {
        const queue = window.getOfflineQueue();
        queue.push({
            id: 'OFFLINE_' + Date.now(),
            timestamp: new Date().toISOString(),
            data: expenseData
        });
        window.saveOfflineQueue(queue);
        alert('You are currently offline. Expense saved locally and will auto-sync when online!');
    };

    window.updateOfflineBadge = function() {
        const queue = window.getOfflineQueue();
        const badge = document.getElementById('offlineSyncBadge');
        if (badge) {
            if (queue.length > 0) {
                badge.textContent = queue.length + ' Offline Claim(s)';
                badge.style.display = 'inline-flex';
            } else {
                badge.style.display = 'none';
            }
        }
    };

    window.syncOfflineQueue = async function() {
        if (!navigator.onLine) return;
        const queue = window.getOfflineQueue();
        if (queue.length === 0) return;

        console.log('Online connection restored. Syncing ' + queue.length + ' offline expenses...');
        const remaining = [];

        for (let i = 0; i < queue.length; i++) {
            const item = queue[i];
            try {
                const formData = new FormData();
                Object.keys(item.data).forEach(k => {
                    formData.append(k, item.data[k]);
                });

                const res = await fetch('/expenses/add', {
                    method: 'POST',
                    body: formData
                });

                if (!res.ok && res.status !== 302) {
                    remaining.push(item);
                }
            } catch (err) {
                remaining.push(item);
            }
        }

        window.saveOfflineQueue(remaining);
        if (remaining.length < queue.length) {
            if (typeof requestMobilePushPermission === 'function' && Notification.permission === 'granted') {
                new Notification('SargTech Expenses', {
                    body: 'Offline expenses successfully synced!',
                    icon: '/images/favicon.png'
                });
            } else {
                alert('Offline expenses successfully synced!');
            }
            window.location.reload();
        }
    };

    window.addEventListener('online', window.syncOfflineQueue);
    window.addEventListener('load', function() {
        window.updateOfflineBadge();
        if (navigator.onLine) window.syncOfflineQueue();
    });
})();
