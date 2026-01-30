/**
 * Full ORM Schema Definition
 * Generated from model classes for consistency
 */

import { Story } from '../models/Story.js';
import { Comment } from '../models/Comment.js';
import { Reaction } from '../models/Reaction.js';
import { Pix } from '../models/Pix.js';
import { PixRegistry } from '../models/PixRegistry.js';
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
  pix: Pix,
  pixRegistry: PixRegistry,
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
