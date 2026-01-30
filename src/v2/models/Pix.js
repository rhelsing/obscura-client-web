import { BaseModel } from './BaseModel.js';

export class Pix extends BaseModel {
  static fields = {
    recipientUsername: 'string',
    senderUsername: 'string',
    mediaRef: 'string',
    caption: 'string?',
    displayDuration: 'number',
    viewedAt: 'timestamp?',
  };

  static sync = 'lww';
  static collectable = false;     // Cannot be pinned
  static ttlTrigger = 'read';     // TTL starts on read/view

  // TTL is the displayDuration from the entry
  static getTTL(entry) {
    return (entry.data?.displayDuration || 8) * 1000;
  }
}
