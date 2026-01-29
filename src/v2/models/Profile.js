import { BaseModel } from './BaseModel.js';

export class Profile extends BaseModel {
  static fields = {
    displayName: 'string',
    avatarUrl: 'string?',
    bio: 'string?',
  };

  static sync = 'lww';
  static collectable = true;
  static ttl = null;  // Inherit user default
}
