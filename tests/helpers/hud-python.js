import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { findPython } from '../../scripts/install-cli-hud.mjs';

export const python = findPython();
export function callHud(name, ...args) {
  const code = 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("hud",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); r=json.loads(sys.stdin.buffer.read().decode("utf-8")); print(json.dumps(getattr(m,r["name"])(*r["args"]),ensure_ascii=True))';
  const result = spawnSync(python, ['-I', '-S', '-c', code, path.resolve('src/cli-hud/hud.py')], {
    input: JSON.stringify({ name, args }), encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}
