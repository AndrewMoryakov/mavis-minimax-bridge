import fs from "node:fs";
import { isPathInsideRoot, pathsEqual, realpathOrResolve } from "./path-security.mjs";

export function validateTarget(targetDir, bridgeDir) {
  if (!targetDir || !String(targetDir).trim()) throw new Error("--target is required");
  const target = realpathOrResolve(targetDir);
  const bridge = realpathOrResolve(bridgeDir);
  if (!fs.existsSync(target)) throw new Error(`target does not exist: ${target}`);
  if (!fs.statSync(target).isDirectory()) throw new Error(`target must be a directory: ${target}`);
  if (pathsEqual(target, bridge)) throw new Error("target must not be the bridge repository");
  if (isPathInsideRoot(bridge, target)) throw new Error("target must not be inside the bridge repository");
  if (isPathInsideRoot(target, bridge)) throw new Error("target must not contain the bridge repository");
  return target;
}
