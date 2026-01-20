// Polyfill IndexedDB for Node.js - MUST be first
import 'fake-indexeddb/auto';

// Polyfill other browser APIs
import { webcrypto } from 'crypto';
import { TextEncoder, TextDecoder } from 'util';

// Set up globals
globalThis.crypto = webcrypto;
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;

// Polyfill atob/btoa
globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');
globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

export { };
