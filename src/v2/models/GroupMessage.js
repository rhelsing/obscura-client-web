import { BaseModel } from './BaseModel.js';

export class GroupMessage extends BaseModel {
  static fields = {
    text: 'string',
  };

  static sync = 'g-set';
  static collectable = true;
  static ttl = '7d';
  static ttlTrigger = 'create';
  static belongs_to = 'group';
}
