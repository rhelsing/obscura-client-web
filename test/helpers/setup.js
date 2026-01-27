// Polyfill IndexedDB for Node.js - MUST be first
import 'fake-indexeddb/auto';

// Polyfill other browser APIs
import { webcrypto } from 'crypto';
import { TextEncoder, TextDecoder } from 'util';

// Set up globals (check if already defined in newer Node.js)
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
}
if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  globalThis.TextDecoder = TextDecoder;
}

// Polyfill atob/btoa
globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');
globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

export { };
