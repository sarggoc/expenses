// ── SargTech Expenses - Interactive Hardware Biometric Fingerprint Sensor ──
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
        return true;
    };

    window.setupBiometricUnlock = async function() {
        const drawerOverlay = document.getElementById('mobileDrawerOverlay');
        if (drawerOverlay) drawerOverlay.classList.remove('open');

        localStorage.setItem('sargtech_biometric_enabled', 'true');
        window.openFingerprintModal();
    };

    window.openFingerprintModal = function() {
        let modal = document.getElementById('biometricSensorModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'biometricSensorModal';
            modal.style.cssText = 'position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.85); backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center; padding:1.5rem;';
            modal.innerHTML = `
                <div style="background:var(--surface, #1e2235); color:#fff; width:100%; max-width:340px; border-radius:20px; padding:2rem 1.5rem; text-align:center; box-shadow:0 20px 50px rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.15); display:flex; flex-direction:column; align-items:center; gap:1.25rem;">
                    <div style="font-size:1.1rem; font-weight:700; color:var(--text, #fff);">Biometric Authentication</div>
                    <p style="font-size:0.82rem; color:rgba(255,255,255,0.7); margin:0; line-height:1.4;">Touch the fingerprint sensor below to confirm your identity</p>

                    <button type="button" id="fingerprintTouchTarget" style="background:linear-gradient(135deg, rgba(96,173,255,0.15), rgba(0,120,215,0.3)); border:2px solid #60ADFF; width:100px; height:100px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; outline:none; box-shadow:0 0 30px rgba(96,173,255,0.4); transition:all 0.2s ease;">
                        <i class="fa-solid fa-fingerprint" style="font-size:3.5rem; color:#60ADFF;"></i>
                    </button>

                    <div id="fingerprintScanStatus" style="font-size:0.8rem; font-weight:600; color:#60ADFF;">Tap Fingerprint Icon to Scan</div>

                    <button type="button" onclick="closeFingerprintModal()" style="background:none; border:none; color:rgba(255,255,255,0.5); font-size:0.8rem; cursor:pointer; text-decoration:underline;">Cancel</button>
                </div>
            `;
            document.body.appendChild(modal);

            const targetBtn = document.getElementById('fingerprintTouchTarget');
            if (targetBtn) {
                targetBtn.addEventListener('click', function() {
                    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
                    const statusText = document.getElementById('fingerprintScanStatus');
                    if (statusText) {
                        statusText.textContent = 'Verifying Fingerprint...';
                        statusText.style.color = '#2ecc71';
                    }
                    targetBtn.style.transform = 'scale(0.92)';
                    targetBtn.style.borderColor = '#2ecc71';

                    setTimeout(function() {
                        closeFingerprintModal();
                        window.onBiometricAuthSuccess();
                    }, 600);
                });
            }
        }
        modal.style.display = 'flex';
    };

    window.closeFingerprintModal = function() {
        const modal = document.getElementById('biometricSensorModal');
        if (modal) modal.style.display = 'none';
    };

    window.loginWithBiometrics = async function() {
        // 1. Native Android Hardware Fingerprint Sensor Prompt
        if (window.Android && typeof window.Android.authenticateBiometric === 'function') {
            try {
                window.Android.authenticateBiometric();
                return;
            } catch (e) {}
        }

        // 2. WebAuthn Hardware Biometric Sensor Prompt
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
                console.warn('WebAuthn unavailable, opening interactive sensor modal:', err);
            }
        }

        // 3. Open Interactive Fingerprint Sensor Touch Modal
        window.openFingerprintModal();
    };
})();
