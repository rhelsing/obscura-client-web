# Security Analysis: Device Management

> Threat model analysis for Obscura's multi-device architecture.

**Version:** 1.0.0
**Status:** Final

---

## Claimed Attack: DeviceAnnounce Injection

**Claim:** An attacker who compromises a device can extract the P2P identity key and forge DeviceAnnounce messages to inject a rogue device into all contacts' device lists, enabling silent message interception.

**Verdict:** Not a valid attack vector.

---

## Why This Attack Fails

### 1. Signal Sessions Are Device-Bound (Primary Defense)

Sending messages requires active Signal sessions, not just keys. A session includes:
- Prekey state
- Ratchet state
- Message counters

These are stored in IndexedDB and bound to the specific device context. An attacker cannot extract keys and use them from another machine — they'd need to clone the entire browser state, at which point they ARE the device, not a separate "rogue" device.

> **Implemented:** Identity keys are encrypted at rest using AES-256-GCM with a key derived from the user's password via PBKDF2 (100k iterations). Keys are only decrypted into memory at login and cleared when the session ends.

### 2. Device Linking Requires Physical QR Ceremony

To add a new device to the identity:

1. New device registers on server (separate account)
2. New device displays QR code containing:
   - `serverUserId`
   - `signalIdentityKey`
   - `challenge` (16 random bytes)
3. Existing device **physically scans** the QR code
4. Existing device sends `DEVICE_LINK_APPROVAL` (Signal-encrypted)
5. New device verifies challenge response

An attacker cannot skip step 3. The QR scan is a physical gate requiring user interaction on a trusted device. There is no API endpoint or message type that allows bypassing this ceremony.

### 3. Compromise = Being the User

If an attacker has:
- Access to IndexedDB, AND
- The user's password

They are not "injecting" a rogue device—they ARE logged in as the user. Any device they add would go through the normal UI flow:

1. Attacker's device shows QR code
2. Compromised device scans it (visible in UI)
3. New device appears in user's device list

The user would see this device in their settings and can revoke it.

### 4. Revocation Handles Actual Compromise

If a device is compromised, the recovery flow is:

1. User notices suspicious activity
2. User enters 12-word recovery phrase on a trusted device
3. Trusted device broadcasts `DeviceAnnounce` with `is_revocation: true`
4. Signature verified against stored `recoveryPublicKey`
5. All friends replace their device list with the new authoritative list (LWW)
6. Any attacker-added device is removed

The recovery phrase is never stored on-device, so an attacker cannot forge revocations or prevent legitimate revocations.

---

## Attack Surface Analysis

| Attack Vector | Mitigated By |
|---------------|--------------|
| Extract keys from IndexedDB | Password-encrypted (AES-256-GCM + PBKDF2) |
| Clone Signal sessions | Requires full browser state + password; attacker becomes the device |
| Forge DeviceAnnounce remotely | Requires active Signal session |
| Bypass QR linking ceremony | No API exists; physical interaction required |
| Prevent revocation | Recovery phrase is offline |
| Persist after device wipe | Revocation replaces entire device list |

---

## What Compromise Actually Means

If an attacker fully compromises a device (has password + active session), they can:

- Read messages on that device
- Send messages as the user from that device
- Add new devices (but only via the visible QR flow)

They cannot:

- Silently inject devices that the user cannot see
- Prevent the user from revoking compromised devices
- Forge revocations without the recovery phrase
- Persist access after proper revocation

This is the inherent reality of any E2E encrypted system: device compromise grants device-level access. The mitigation is the recovery phrase, which enables full identity recovery from a trusted device.

---

## Comparison to Signal

Signal's security model is similar:

| Aspect | Signal | Obscura |
|--------|--------|---------|
| Device linking | QR code scan | QR code scan |
| Key storage | OS keychain (encrypted) | IndexedDB (password-encrypted) |
| Identity key change | Safety number changes, user prompted | DeviceAnnounce, LWW merge |
| Revocation | "Unlink" in settings | Recovery phrase + DeviceAnnounce |
| Compromise recovery | Re-register | Revoke via recovery phrase |

Obscura's recovery phrase provides stronger recovery guarantees than Signal's re-registration flow, as it allows revoking specific devices without losing identity.

---

## Recommendations

1. **User education:** Users should understand that the recovery phrase is the ultimate authority over their identity. Store it securely offline.

2. **Device list visibility:** The UI should prominently display linked devices so users notice unexpected additions.

3. **Revocation alerts:** When a revocation is received, notify the user that a contact's device list changed (similar to Signal's "safety number changed" notification).

4. **Session timeouts:** Consider automatic logout after inactivity to limit exposure if a device is physically accessed while unlocked.

---

## Conclusion

The "DeviceAnnounce Injection" attack assumes an attacker can:
1. Extract unencrypted keys
2. Use them from an external context
3. Bypass the QR linking ceremony

None of these are possible in the actual implementation. The combination of password-encrypted storage, stateful Signal sessions, and physical QR verification prevents remote device injection.

Device compromise is a real threat, but the attack surface is limited to "act as the user on the compromised device"—which is mitigated by the recovery phrase revocation mechanism.
