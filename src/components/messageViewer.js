// Timed message viewer component
// Displays a photo message for the specified duration then closes

export function showMessageViewer(container, message, onClose) {
  const duration = message.displayDuration || 8;
  let remainingSeconds = duration;
  let timer = null;

  const viewer = document.createElement('div');
  viewer.className = 'message-viewer';

  function renderTimerDots() {
    const dots = [];
    for (let i = 0; i < duration; i++) {
      dots.push(`<div class="timer-dot ${i < remainingSeconds ? 'active' : ''}"></div>`);
    }
    return dots.join('');
  }

  viewer.innerHTML = `
    <div class="message-viewer-header">
      <div class="message-viewer-sender">${message.senderUsername || message.fromUserId.slice(0, 8)}</div>
    </div>
    <div class="message-viewer-content">
      <img src="${message.imageData}" alt="Message">
    </div>
    <div class="message-viewer-overlay">
      ${message.text ? `<div class="message-viewer-text">${escapeHtml(message.text)}</div>` : ''}
      <div class="message-viewer-timer" id="timer-dots">
        ${renderTimerDots()}
      </div>
    </div>
  `;

  container.appendChild(viewer);

  // Start countdown
  timer = setInterval(() => {
    remainingSeconds--;
    const timerDots = viewer.querySelector('#timer-dots');
    if (timerDots) {
      timerDots.innerHTML = renderTimerDots();
    }

    if (remainingSeconds <= 0) {
      close();
    }
  }, 1000);

  // Allow tap to close early (optional - you might want to remove this for true ephemeral messages)
  viewer.addEventListener('click', () => {
    // Don't allow early close - force them to watch
    // Uncomment below to allow tap-to-close:
    // close();
  });

  function close() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    viewer.remove();
    if (onClose) onClose();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  return { close };
}
