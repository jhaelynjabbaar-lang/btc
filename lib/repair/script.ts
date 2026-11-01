import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loads the Windows 7 script (agent/win7-repair/repair.bat), fills the public relay URL placeholder, and normalizes line endings
 * to CRLF (cmd.exe is happiest with CRLF). Returns the exact bytes served at /r plus their SHA-256, so the person at the PC can
 * compare `certutil -hashfile repair.bat SHA256` with the value shown on the admin page. No secrets are ever in the script.
 */
export const SCRIPT_PATH = "agent/win7-repair/repair.bat";

export function renderScript(source: string, relayUrl: string): { text: string; sha256: string } {
  const url = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\/-]*)?$/.test(relayUrl) ? relayUrl.replace(/\/+$/, "") : "";
  const text = source.replace(/\r\n/g, "\n").replace(/__RELAY_URL__/g, url).replace(/\n/g, "\r\n");
  return { text, sha256: createHash("sha256").update(text, "latin1").digest("hex") };
}

export function loadScript(): { text: string; sha256: string } {
  const source = readFileSync(path.join(process.cwd(), SCRIPT_PATH), "utf8");
  return renderScript(source, process.env.REPAIR_RELAY_URL?.trim() ?? "");
}
