/**
 * Model Registry
 *
 * Auto-discovers all model files in this directory.
 * To add a new model: create ModelName.js extending BaseModel.
 */

import { BaseModel } from './BaseModel.js';
export { BaseModel };

// Auto-import all model files (Vite)
const modelModules = import.meta.glob('./*.js', { eager: true });

/**
 * All model classes by name (auto-discovered)
 */
export const models = {};

for (const [path, module] of Object.entries(modelModules)) {
  // Skip index.js and BaseModel.js
  if (path === './index.js' || path === './BaseModel.js') continue;

  // Get the exported class (assumes default or named export matching filename)
  const ModelClass = module.default || Object.values(module)[0];

  if (ModelClass && ModelClass.prototype instanceof BaseModel) {
    // Derive model name from filename: ./Snap.js -> snap
    const name = path.replace('./', '').replace('.js', '');
    const modelName = name.charAt(0).toLowerCase() + name.slice(1);
    models[modelName] = ModelClass;
  }
}

/**
 * Convert model classes to schema config format
 */
export function modelsToSchema() {
  const schema = {};
  for (const [name, ModelClass] of Object.entries(models)) {
    schema[name] = ModelClass.toConfig();
  }
  return schema;
}

/**
 * Get model class by name
 */
export function getModelClass(name) {
  return models[name] || null;
}
