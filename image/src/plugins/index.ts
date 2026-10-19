import type { PluginDef } from '../plugin.js';
import webhookForward from './webhook-forward.js';
import ping from './ping.js';
import activityStatus from './activity-status.js';
// Built-in plugins. Add new ones here (code-reviewed, baked into the image; no runtime code loading).
export const PLUGINS: Record<string, PluginDef> = {
  [webhookForward.name]: webhookForward,
  [ping.name]: ping,
  [activityStatus.name]: activityStatus,
};
