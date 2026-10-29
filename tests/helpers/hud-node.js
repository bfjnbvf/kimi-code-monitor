import * as hud from '../../src/cli-hud/hud.mjs';

export const node = process.execPath;
const functions = {
  render: hud.render,
  usage_bucket: hud.usageBucket,
  parse_activity: hud.parseActivity,
  cell_width: hud.cellWidth,
  module_options: hud.moduleOptions,
  read_activity: hud.readActivity,
  read_quota: hud.readQuota,
};

export function callHud(name, ...args) {
  return functions[name](...args);
}
