// ── SargTech Expenses - Hardware Biometric Authentication Only ──
(function() {
    window.onBiometricAuthSuccess = async function() {
        try {
            const res = await fetch('/login/biometric', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (data.success && data.redirect) {
                window.location.href = data.redirect;
                return;
            }
        } catch (e) {
            console.error('Biometric auth session error:', e);
        }
        window.location.href = '/dashboard';
    };

    window.isBiometricsSupported = function() {
        return !!(
            (window.Android && typeof window.Android.authenticateBiometric === 'function') ||
            (window.PublicKeyCredential && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function')
        );
    };

    window.setupBiometricUnlock = async function() {
        const drawerOverlay = document.getElementById('mobileDrawerOverlay');
        if (drawerOverlay) drawerOverlay.classList.remove('open');

        localStorage.setItem('sargtech_biometric_enabled', 'true');
        window.loginWithBiometrics();
    };

    window.loginWithBiometrics = async function() {
        // 1. Native Android Hardware Biometric System Prompt
        if (window.Android && typeof window.Android.authenticateBiometric === 'function') {
            try {
                window.Android.authenticateBiometric();
                return; // Wait for hardware fingerprint scan callback: window.onBiometricAuthSuccess()
            } catch (e) {
                console.warn('Native Android biometric bridge error:', e);
            }
        }

        // 2. Hardware WebAuthn FIDO2 Sensor Prompt (Chrome / HTTPS / WebViews)
        if (window.PublicKeyCredential && typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
            try {
                const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
                if (available) {
                    const challenge = new Uint8Array(32);
                    window.crypto.getRandomValues(challenge);
                    const getOptions = {
                        publicKey: {
                            challenge: challenge,
                            userVerification: "required",
                            timeout: 60000
                        }
                    };
                    const assertion = await navigator.credentials.get(getOptions);
                    if (assertion) {
                        window.onBiometricAuthSuccess();
                        return;
                    }
                }
            } catch (err) {
                console.warn('Hardware biometric verification failed or cancelled:', err);
                if (typeof window.showMobileToast === 'function') {
                    window.showMobileToast('Hardware fingerprint verification failed', 'fa-circle-xmark');
                }
                return; // DO NOT LOG IN IF HARDWARE SCAN WAS NOT VERIFIED
            }
        }

        // If hardware biometric sensor is not available on this browser/connection:
        if (typeof window.showMobileToast === 'function') {
            window.showMobileToast('Hardware fingerprint sensor not detected on this browser/connection', 'fa-circle-xmark');
        }
    };
})();
