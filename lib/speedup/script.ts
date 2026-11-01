import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loads the Windows 7 speed-up script (agent/win7-speedup/speedup.bat) and normalizes line endings to CRLF (cmd.exe is happiest
 * with CRLF). The script is fully offline and has no placeholders, so the served bytes are the file's bytes. The SHA-256 of the
 * served text is returned so it can be compared with `certutil -hashfile speedup.bat SHA256` on the PC.
 */
export const SPEEDUP_PATH = "agent/win7-speedup/speedup.bat";

export function normalizeScript(source: string): { text: string; sha256: string } {
  const text = source.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  return { text, sha256: createHash("sha256").update(text, "latin1").digest("hex") };
}

export function loadSpeedupScript(): { text: string; sha256: string } {
  return normalizeScript(readFileSync(path.join(process.cwd(), SPEEDUP_PATH), "utf8"));
}
