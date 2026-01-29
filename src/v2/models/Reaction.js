import { BaseModel } from './BaseModel.js';

export class Reaction extends BaseModel {
  static fields = {
    emoji: 'string',
  };

  static sync = 'lww';
  static collectable = true;
  static ttl = '24h';
  static ttlTrigger = 'create';
  static belongs_to = ['story', 'comment'];
}
