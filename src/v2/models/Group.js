import { BaseModel } from './BaseModel.js';

export class Group extends BaseModel {
  static fields = {
    name: 'string',
    members: 'string',  // JSON array of usernames
  };

  static sync = 'g-set';
  static collectable = true;
  static ttl = null;
  static has_many = ['groupMessage'];
}
