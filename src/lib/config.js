// Feature flags - compile-time constants
export const FEATURES = {
  // Use /v1/attachments API for images instead of inline bytes
  // When true: upload image to attachments, send reference in message
  // When false: send image bytes inline in message (current behavior)
  USE_ATTACHMENTS: false,
};
