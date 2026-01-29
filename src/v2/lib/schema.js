/**
 * Full ORM Schema Definition
 * Generated from model classes for consistency
 */

import { Story } from '../models/Story.js';
import { Comment } from '../models/Comment.js';
import { Reaction } from '../models/Reaction.js';
import { Snap } from '../models/Snap.js';
import { Streak } from '../models/Streak.js';
import { Profile } from '../models/Profile.js';
import { Settings } from '../models/Settings.js';
import { Group } from '../models/Group.js';
import { GroupMessage } from '../models/GroupMessage.js';

/**
 * All model classes
 */
export const modelClasses = {
  story: Story,
  comment: Comment,
  reaction: Reaction,
  snap: Snap,
  streak: Streak,
  profile: Profile,
  settings: Settings,
  group: Group,
  groupMessage: GroupMessage,
};

/**
 * Build schema from model classes
 */
export function buildSchema() {
  const schema = {};
  for (const [name, ModelClass] of Object.entries(modelClasses)) {
    schema[name] = ModelClass.toConfig();
  }
  return schema;
}

/**
 * Full schema (generated from models)
 */
export const fullSchema = buildSchema();
