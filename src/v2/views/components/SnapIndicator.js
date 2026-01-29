/**
 * SnapIndicator Component
 * Red/purple square icon indicating unviewed snaps (Snapchat style)
 */

/**
 * Render a snap indicator
 * @param {Object} opts
 * @param {'photo'|'video'} [opts.type='photo'] - Type of snap (red for photo, purple for video)
 * @param {number} [opts.count] - Number of unviewed snaps (optional)
 * @returns {string} HTML string
 */
export function renderSnapIndicator(opts = {}) {
  const { type = 'photo', count } = opts;
  const color = type === 'video' ? 'var(--ry-color-purple-500, #9333ea)' : 'var(--ry-color-red-500, #ef4444)';

  return `
    <span class="snap-indicator" style="--snap-color: ${color}">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
        <rect x="1" y="1" width="10" height="10" rx="1" fill="${color}" />
      </svg>
      ${count && count > 1 ? `<span class="snap-count">${count}</span>` : ''}
    </span>
  `;
}

/**
 * Check if a friend has unviewed snaps
 * @param {Map} snapsByFriend - Map of senderUsername -> snap[]
 * @param {string} friendUsername
 * @returns {{ hasSnaps: boolean, count: number, type: 'photo'|'video' }}
 */
export function getSnapStatus(snapsByFriend, friendUsername) {
  const snaps = snapsByFriend.get(friendUsername) || [];
  if (snaps.length === 0) {
    return { hasSnaps: false, count: 0, type: 'photo' };
  }

  // Check if any are video (for purple indicator)
  // For now, assume all are photos since we don't have video yet
  const type = 'photo';

  return { hasSnaps: true, count: snaps.length, type };
}
