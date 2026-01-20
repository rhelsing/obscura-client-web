// QR Code modal component
import QRCode from 'qrcode';

export function showQRModal(container, userId, username, onClose) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-title">Your QR Code</div>
      <div class="modal-subtitle">Let friends scan to add you</div>
      <div class="qr-container" id="qr-container"></div>
      <div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 1rem;">
        @${username}
      </div>
      <button class="modal-close" id="modal-close">Close</button>
    </div>
  `;

  container.appendChild(overlay);

  // Generate QR code
  const qrContainer = overlay.querySelector('#qr-container');
  QRCode.toCanvas(userId, {
    width: 200,
    margin: 0,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  }, (err, canvas) => {
    if (err) {
      console.error('QR generation error:', err);
      qrContainer.innerHTML = '<div style="color: var(--danger);">Failed to generate QR code</div>';
      return;
    }
    qrContainer.appendChild(canvas);
  });

  // Close handlers
  const closeBtn = overlay.querySelector('#modal-close');
  closeBtn.addEventListener('click', close);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close();
    }
  });

  function close() {
    overlay.remove();
    if (onClose) onClose();
  }

  return { close };
}
