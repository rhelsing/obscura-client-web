/**
 * PixIndicator Component
 *
 * RECEIVED pix (square):
 * - Filled square = unviewed pix from friend
 * - Outlined square = opened/viewed pix
 *
 * SENT pix (chevron right):
 * - Filled chevron = sent, waiting for recipient to open
 * - Outlined chevron = sent and opened by recipient
 */

/**
 * Render a filled pix indicator (unviewed received pix)
 * @param {Object} opts
 * @param {'photo'|'video'} [opts.type='photo'] - Type of pix (red for photo, purple for video)
 * @param {number} [opts.count] - Number of unviewed pix (optional)
 * @returns {string} HTML string
 */
export function renderPixIndicator(opts = {}) {
  const { type = 'photo', count } = opts;
  const color = type === 'video' ? 'var(--ry-color-purple-500, #9333ea)' : 'var(--ry-color-red-500, #ef4444)';

  return `
    <span class="pix-indicator pix-indicator--filled" style="--pix-color: ${color}">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <rect x="1" y="1" width="12" height="12" rx="2" fill="${color}" />
      </svg>
      ${count && count > 1 ? `<span class="pix-count">${count}</span>` : ''}
    </span>
  `;
}

/**
 * Render an outlined pix indicator (opened/viewed received pix)
 * @param {Object} opts
 * @param {'photo'|'video'} [opts.type='photo'] - Type of pix
 * @returns {string} HTML string
 */
export function renderPixIndicatorOpened(opts = {}) {
  const { type = 'photo' } = opts;
  const color = type === 'video' ? 'var(--ry-color-purple-500, #9333ea)' : 'var(--ry-color-red-500, #ef4444)';

  return `
    <span class="pix-indicator pix-indicator--opened" style="--pix-color: ${color}">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="none" stroke="${color}" stroke-width="1.5" />
      </svg>
    </span>
  `;
}

/**
 * Render a filled chevron indicator (sent pix, pending - not yet opened by recipient)
 * @param {Object} opts
 * @param {'photo'|'video'} [opts.type='photo'] - Type of pix
 * @returns {string} HTML string
 */
export function renderPixIndicatorSent(opts = {}) {
  const { type = 'photo' } = opts;
  const color = type === 'video' ? 'var(--ry-color-purple-500, #9333ea)' : 'var(--ry-color-red-500, #ef4444)';

  // Right-facing chevron, filled
  return `
    <span class="pix-indicator pix-indicator--sent" style="--pix-color: ${color}">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M5 2 L11 7 L5 12 Z" fill="${color}" />
      </svg>
    </span>
  `;
}

/**
 * Render an outlined chevron indicator (sent pix, opened by recipient)
 * @param {Object} opts
 * @param {'photo'|'video'} [opts.type='photo'] - Type of pix
 * @returns {string} HTML string
 */
export function renderPixIndicatorSentOpened(opts = {}) {
  const { type = 'photo' } = opts;
  const color = type === 'video' ? 'var(--ry-color-purple-500, #9333ea)' : 'var(--ry-color-red-500, #ef4444)';

  // Right-facing chevron, outlined
  return `
    <span class="pix-indicator pix-indicator--sent-opened" style="--pix-color: ${color}">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M5 2 L11 7 L5 12" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
    </span>
  `;
}

/**
 * Check if a friend has unviewed pix
 * @param {Map} pixByFriend - Map of senderUsername -> pix[]
 * @param {string} friendUsername
 * @returns {{ hasPix: boolean, count: number, type: 'photo'|'video' }}
 */
export function getPixStatus(pixByFriend, friendUsername) {
  const pixList = pixByFriend.get(friendUsername) || [];
  if (pixList.length === 0) {
    return { hasPix: false, count: 0, type: 'photo' };
  }

  // Check if any are video (for purple indicator)
  // For now, assume all are photos since we don't have video yet
  const type = 'photo';

  return { hasPix: true, count: pixList.length, type };
}
