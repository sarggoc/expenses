// ── SargTech Expenses - WebAuthn Biometric FaceID / Fingerprint Unlock ──
(function() {
    window.isBiometricsSupported = function() {
        return !!(window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable);
    };

    window.setupBiometricUnlock = async function() {
        if (!window.isBiometricsSupported()) {
            alert('Biometric authentication (FaceID / Fingerprint) is not supported on this device.');
            return;
        }

        try {
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            if (!available) {
                alert('No biometric sensor (FaceID / Fingerprint) found or configured on this device.');
                return;
            }

            // Generate simple biometric registration challenge
            const challenge = new Uint8Array(32);
            window.crypto.getRandomValues(challenge);

            const userIdStr = 'user_' + Date.now();
            const userIdArr = new TextEncoder().encode(userIdStr);

            const createOptions = {
                publicKey: {
                    rp: { name: "SargTech Expenses Mobile" },
                    user: {
                        id: userIdArr,
                        name: "employee@sargtech.com",
                        displayName: "Employee User"
                    },
                    challenge: challenge,
                    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                    authenticatorSelection: {
                        authenticatorAttachment: "platform",
                        userVerification: "required"
                    },
                    timeout: 60000
                }
            };

            const credential = await navigator.credentials.create(createOptions);
            if (credential) {
                localStorage.setItem('sargtech_biometric_enabled', 'true');
                localStorage.setItem('sargtech_biometric_id', credential.id);
                alert('FaceID / Fingerprint biometric unlock registered successfully!');
            }
        } catch (err) {
            console.error('Biometric setup failed:', err);
            alert('Biometric setup cancelled or failed: ' + err.message);
        }
    };

    window.loginWithBiometrics = async function() {
        if (!localStorage.getItem('sargtech_biometric_enabled')) {
            alert('Biometric unlock is not enabled yet. Log in with password first to set up Biometrics.');
            return;
        }

        try {
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
                alert('Biometric authentication verified! Logging in...');
                window.location.href = '/dashboard';
            }
        } catch (err) {
            console.error('Biometric login failed:', err);
            alert('Biometric verification failed: ' + err.message);
        }
    };
})();
