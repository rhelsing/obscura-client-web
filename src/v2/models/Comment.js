import { BaseModel } from './BaseModel.js';

export class Comment extends BaseModel {
  static fields = {
    text: 'string',
  };

  static sync = 'g-set';
  static collectable = true;
  static ttl = '24h';
  static ttlTrigger = 'create';
  static belongs_to = ['story', 'comment'];
  static has_many = ['comment', 'reaction'];
}
