/**
 * Logs View - displays all message send/receive events
 */
import { navigate, clearClient } from '../index.js';
import { renderNav, initNav } from '../components/Nav.js';
import { ObscuraClient } from '../../lib/ObscuraClient.js';
import { logger } from '../../lib/logger.js';
import { LogEventType } from '../../lib/logStore.js';

// Re-export LogEventType for local use (imported from logStore)

// Color coding for event types
const EVENT_COLORS = {
  [LogEventType.SEND_START]: '#3b82f6',
  [LogEventType.SEND_ENCRYPT_START]: '#60a5fa',
  [LogEventType.SEND_ENCRYPT_COMPLETE]: '#60a5fa',
  [LogEventType.SEND_COMPLETE]: '#22c55e',
  [LogEventType.SEND_ERROR]: '#ef4444',
  [LogEventType.RECEIVE_ENVELOPE]: '#a855f7',
  [LogEventType.RECEIVE_DECRYPT_START]: '#c084fc',
  [LogEventType.RECEIVE_DECRYPT_COMPLETE]: '#c084fc',
  [LogEventType.RECEIVE_DECODE]: '#d8b4fe',
  [LogEventType.RECEIVE_COMPLETE]: '#22c55e',
  [LogEventType.RECEIVE_ERROR]: '#ef4444',
  [LogEventType.MESSAGE_LOST]: '#dc2626',
  [LogEventType.SESSION_ESTABLISH]: '#f97316',
  [LogEventType.SESSION_RESET]: '#fb923c',
  [LogEventType.GATEWAY_CONNECT]: '#6b7280',
  [LogEventType.GATEWAY_DISCONNECT]: '#9ca3af',
  [LogEventType.GATEWAY_ACK]: '#d1d5db',
};

const EVENT_DIRECTION = {
  [LogEventType.SEND_START]: 'out',
  [LogEventType.SEND_ENCRYPT_START]: 'out',
  [LogEventType.SEND_ENCRYPT_COMPLETE]: 'out',
  [LogEventType.SEND_COMPLETE]: 'out',
  [LogEventType.SEND_ERROR]: 'out',
  [LogEventType.RECEIVE_ENVELOPE]: 'in',
  [LogEventType.RECEIVE_DECRYPT_START]: 'in',
  [LogEventType.RECEIVE_DECRYPT_COMPLETE]: 'in',
  [LogEventType.RECEIVE_DECODE]: 'in',
  [LogEventType.RECEIVE_COMPLETE]: 'in',
  [LogEventType.RECEIVE_ERROR]: 'in',
  [LogEventType.MESSAGE_LOST]: 'error',
  [LogEventType.SESSION_ESTABLISH]: 'session',
  [LogEventType.SESSION_RESET]: 'session',
  [LogEventType.GATEWAY_CONNECT]: 'gateway',
  [LogEventType.GATEWAY_DISCONNECT]: 'gateway',
  [LogEventType.GATEWAY_ACK]: 'gateway',
};

let cleanup = null;

// Plain text formatting for clipboard copy
function formatTimestamp(ts) {
  const date = new Date(ts);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

function formatDataPlain(data, indent = 0) {
  if (data === null || data === undefined) return 'null';
  if (typeof data !== 'object') return String(data);

  const prefix = '  '.repeat(indent);
  const lines = [];

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object' && value !== null) {
      if (value.type === 'Uint8Array' || value.type === 'ArrayBuffer') {
        lines.push(`${prefix}${key}: [${value.type}] ${value.length} bytes${value.truncated ? ' (truncated)' : ''}`);
        lines.push(`${prefix}  ${value.preview}`);
      } else {
        lines.push(`${prefix}${key}:`);
        lines.push(formatDataPlain(value, indent + 1));
      }
    } else {
      lines.push(`${prefix}${key}: ${value}`);
    }
  }

  return lines.join('\n');
}

function formatEventPlain(event) {
  const direction = EVENT_DIRECTION[event.eventType] || '';
  const dirArrow = direction === 'out' ? '↑' : direction === 'in' ? '↓' : direction === 'session' ? '⇄' : '↔';
  const time = formatTimestamp(event.timestamp);
  const type = event.eventType.replace(/_/g, ' ').toLowerCase();

  let text = `[${time}] ${dirArrow} ${type} (${(event.correlationId || '').slice(-6)})`;
  if (event.data && Object.keys(event.data).length > 0) {
    text += '\n' + formatDataPlain(event.data, 1);
  }
  return text;
}

export function render({ events = [], expandedEvent = null } = {}) {
  return `
    <div class="view logs">
      <header>
        <h1>Logs</h1>
        <ry-cluster>
          <button variant="secondary" id="copy-btn"><ry-icon name="copy"></ry-icon> Copy</button>
          <button variant="secondary" id="clear-btn"><ry-icon name="trash"></ry-icon> Clear</button>
        </ry-cluster>
      </header>

      <ry-cluster style="margin: var(--ry-space-2) 0">
        <badge variant="primary">${events.length} events</badge>
        <span class="live-dot"></span>
      </ry-cluster>

      <stack gap="xs" class="logs-list">
        ${events.length === 0 ? `
          <div class="empty">
            <p>No events logged yet</p>
            <ry-alert type="info">Send or receive messages to see logs here</ry-alert>
          </div>
        ` : events.map(event => renderEvent(event, expandedEvent)).join('')}
      </stack>

      ${renderNav('more')}
    </div>
  `;
}

function renderEvent(event, expandedEvent) {
  const color = EVENT_COLORS[event.eventType] || '#6b7280';
  const direction = EVENT_DIRECTION[event.eventType] || '';
  const isExpanded = expandedEvent === event.id;

  const dirIcon = direction === 'out' ? '↑' : direction === 'in' ? '↓' : direction === 'session' ? '⇄' : '↔';

  const time = new Date(event.timestamp);
  const timeStr = time.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + '.' + String(time.getMilliseconds()).padStart(3, '0');

  const typeStr = event.eventType.replace(/_/g, ' ').toLowerCase();

  return `
    <card class="log-event ${isExpanded ? 'expanded' : ''}" data-id="${event.id}">
      <cluster>
        <span class="log-dir ${direction}">${dirIcon}</span>
        <span style="font-family: monospace; color: var(--ry-color-text-muted); font-size: var(--ry-text-sm)">${timeStr}</span>
        <badge style="background: ${color}; color: white">${typeStr}</badge>
        <span style="font-family: monospace; color: var(--ry-color-text-muted); font-size: var(--ry-text-sm); margin-left: auto">${(event.correlationId || '').slice(-6)}</span>
        <ry-icon name="${isExpanded ? 'chevron-down' : 'chevron-right'}"></ry-icon>
      </cluster>
      ${isExpanded ? `
        <divider></divider>
        <pre style="font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: var(--ry-color-bg); padding: var(--ry-space-3); border-radius: var(--ry-radius-sm); max-height: 200px; overflow-y: auto">${JSON.stringify(event.data, null, 2)}</pre>
      ` : ''}
    </card>
  `;
}

export async function mount(container, client, router) {
  let events = [];
  let expandedEvent = null;
  let unsubscribe = null;

  // Load existing events from logger
  try {
    events = await logger.getAllEvents(200);
  } catch (err) {
    console.warn('[Logs] Failed to load events:', err);
  }

  // Subscribe to new events
  unsubscribe = logger.onLog((event) => {
    events.unshift(event);
    if (events.length > 200) events.pop();
    rerender();
  });

  function rerender() {
    container.innerHTML = render({ events, expandedEvent });
    attachListeners();
  }

  function attachListeners() {
    // Copy
    container.querySelector('#copy-btn')?.addEventListener('click', async () => {
      const text = events.map(formatEventPlain).join('\n\n');
      try {
        await navigator.clipboard.writeText(text);
        const btn = container.querySelector('#copy-btn');
        if (btn) {
          const original = btn.innerHTML;
          btn.innerHTML = '<ry-icon name="check"></ry-icon> Copied!';
          setTimeout(() => { btn.innerHTML = original; }, 1500);
        }
      } catch (err) {
        console.warn('[Logs] Failed to copy:', err);
      }
    });

    // Clear
    container.querySelector('#clear-btn')?.addEventListener('click', async () => {
      try {
        await logger.clearAll();
        events = [];
        rerender();
      } catch (err) {
        console.warn('[Logs] Failed to clear:', err);
      }
    });

    // Expand/collapse
    container.querySelectorAll('.log-event').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseFloat(el.dataset.id);
        expandedEvent = expandedEvent === id ? null : id;
        rerender();
      });
    });

    // Nav
    initNav(container, () => {
      client.disconnect();
      ObscuraClient.clearSession();
      clearClient();
      navigate('/login');
    });

    router.updatePageLinks();
  }

  rerender();

  cleanup = () => {
    // Unsubscribe from logger
    if (unsubscribe) {
      unsubscribe();
    }
  };
}

export function unmount() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
