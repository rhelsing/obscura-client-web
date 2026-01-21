// Feature flags - compile-time constants
export const FEATURES = {
  // Use /v1/attachments API for images instead of inline bytes
  // When true: upload image to attachments, send reference in message
  // When false: send image bytes inline in message (current behavior)
  USE_ATTACHMENTS: false,

  // Use Ed25519 signatures instead of XEdDSA (libsignal default)
  // When true: generate pure Ed25519 keys and signatures (server compatible)
  // When false: use libsignal's Curve25519 + XEdDSA signatures
  // NOTE: Ed25519 breaks Signal Protocol messaging - server needs XEdDSA support
  USE_ED_SIGNING: false,
};
