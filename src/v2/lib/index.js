/**
 * Obscura Client Library
 * Clean, unified API for encrypted messaging
 */

import { register, login } from './auth.js';
import { ObscuraClient } from './ObscuraClient.js';
import { createStore, InMemoryStore, IndexedDBStore } from './store.js';
import { FriendManager } from './friends.js';
import { DeviceManager } from './devices.js';
import { Messenger, MessageType, MessageTypeName } from './messenger.js';

/**
 * Main Obscura namespace
 */
export const Obscura = {
  /**
   * Register a new user
   * @param {string} username - Display username
   * @param {string} password - Password
   * @param {object} opts - { apiUrl, store? }
   * @returns {Promise<ObscuraClient>}
   */
  async register(username, password, opts = {}) {
    const result = await register(username, password, opts);

    return new ObscuraClient({
      apiUrl: opts.apiUrl,
      wsBasePath: opts.wsBasePath,
      protoBasePath: opts.protoBasePath,
      store: result.store,
      token: result.token,
      refreshToken: result.refreshToken,
      userId: result.userId,
      username: result.username,
      deviceUsername: result.deviceUsername,
      deviceUUID: result.deviceUUID,
      deviceInfo: result.deviceInfo,
      p2pIdentity: result.p2pIdentity,
      recoveryPublicKey: result.recoveryPublicKey,  // Only public key, never private
      recoveryPhrase: result.getRecoveryPhrase(),
    });
  },

  /**
   * Login to existing account
   * @param {string} username - Display username
   * @param {string} password - Password
   * @param {object} opts - { apiUrl, store? }
   * @returns {Promise<{ status: string, client?: ObscuraClient, linkCode?: string, reason?: string }>}
   */
  async login(username, password, opts = {}) {
    const result = await login(username, password, opts);

    if (result.status === 'ok') {
      return {
        status: 'ok',
        client: new ObscuraClient({
          apiUrl: opts.apiUrl,
          protoBasePath: opts.protoBasePath,
          store: result.client.store,
          token: result.client.token,
          refreshToken: result.client.refreshToken,
          userId: result.client.userId,
          username: result.client.username || username,
          deviceUsername: result.client.deviceUsername,
          deviceUUID: result.client.deviceUUID,
          deviceInfo: result.client.deviceInfo,
        }),
      };
    }

    if (result.status === 'newDevice') {
      return {
        status: 'newDevice',
        linkCode: result.linkCode,
        client: new ObscuraClient({
          apiUrl: opts.apiUrl,
          protoBasePath: opts.protoBasePath,
          store: result.client.store,
          token: result.client.token,
          refreshToken: result.client.refreshToken,
          userId: result.client.userId,
          username: result.client.username || username,
          deviceUsername: result.client.deviceUsername,
          deviceUUID: result.client.deviceUUID,
          deviceInfo: result.client.deviceInfo,
          linkCode: result.linkCode,
        }),
      };
    }

    return {
      status: 'error',
      reason: result.reason,
    };
  },
};

// Export individual modules for advanced use
export {
  ObscuraClient,
  createStore,
  InMemoryStore,
  IndexedDBStore,
  FriendManager,
  DeviceManager,
  Messenger,
  MessageType,
  MessageTypeName,
};
