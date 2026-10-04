import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
// npm bin links and macOS temporary directories can be symlinked. Compare
// canonical paths so installed commands actually run, not just imported tests.
export function isEntryPoint(url) {
  if (!process.argv[1]) return false;
  try { return pathToFileURL(realpathSync(process.argv[1])).href === url; } catch { return false; }
}
