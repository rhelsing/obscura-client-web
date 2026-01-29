import { BaseModel } from './BaseModel.js';

export class Story extends BaseModel {
  static fields = {
    content: 'string',
    mediaUrl: 'string?',
    authorUsername: 'string?',
  };

  static sync = 'g-set';
  static collectable = true;
  static ttl = '24h';
  static ttlTrigger = 'create';
  static has_many = ['comment', 'reaction'];
}
