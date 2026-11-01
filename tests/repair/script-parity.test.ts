import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS, ACTION_IDS, FINDING_IDS, FIREFOX, OFFLINE_ORDER } from "@/lib/repair/actions";
import { renderScript } from "@/lib/repair/script";

const root = process.cwd();
const source = readFileSync(path.join(root, "agent/win7-repair/repair.bat"), "utf8");
const ps = source.slice(source.indexOf("#PS" + "START"));

function table() {
  const m = /\$ActionTable = @'\r?\n([\s\S]*?)\r?\n'@/.exec(ps);
  expect(m).not.toBeNull();
  return m![1]!.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("|"));
}

describe("repair.bat <-> TypeScript allowlist parity", () => {
  it("the script's embedded action table has exactly the same ids as ACTION_IDS", () => {
    expect(table().map((r) => r[0])).toEqual([...ACTION_IDS]);
  });
  it("admin/reboot flags, related findings and titles match actions.ts", () => {
    for (const r of table()) {
      const a = ACTIONS.find((x) => x.id === r[0])!;
      expect(r[1], `${a.id} admin`).toBe(a.needsAdmin ? "1" : "0");
      expect(r[2], `${a.id} reboot`).toBe(a.reboot ? "1" : "0");
      expect(r[4]!.split(",").filter(Boolean), `${a.id} related`).toEqual([...a.related]);
      expect(r[5], `${a.id} title`).toBe(a.title);
      expect(r[6], `${a.id} changes`).toBe(a.changes);
    }
  });
  it("every action runs at least one embedded command, or is a special @download/@install action", () => {
    for (const r of table()) expect((r[7] ?? "").trim().length, r[0]).toBeGreaterThan(0);
  });
  it("offline order marker equals OFFLINE_ORDER", () => {
    const m = /#OFFLINE_ORDER (\S+)/.exec(ps);
    expect(m![1]!.split(",")).toEqual([...OFFLINE_ORDER]);
  });
  it("every finding id the script emits is on the finding allowlist, and every finding id is emitted", () => {
    const used = new Set([...ps.matchAll(/\bAddF '([a-z0-9_.]+)'/g)].map((m) => m[1]!));
    for (const id of used) expect(FINDING_IDS as readonly string[], id).toContain(id);
    for (const id of FINDING_IDS) expect(used.has(id), `script never reports ${id}`).toBe(true);
  });
  it("Firefox pin matches", () => {
    expect(ps).toContain(FIREFOX.sha256);
    expect(ps).toContain(FIREFOX.url);
  });
  it("migration CHECK list equals ACTION_IDS", () => {
    const sql = readFileSync(path.join(root, "supabase/migrations/20261101210001_repair_agent.sql"), "utf8");
    const m = /action_id[^;]*?check \(action_id in \(([^)]*)\)\)/i.exec(sql);
    expect(m).not.toBeNull();
    const ids = [...m![1]!.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    expect(new Set(ids)).toEqual(new Set(ACTION_IDS));
  });
});

describe("repair.bat safety properties", () => {
  it("is ASCII only", () => expect(/^[\x00-\x7F]*$/.test(source)).toBe(true));
  it("contains no secrets, URLs other than the pinned Mozilla/Microsoft sources, and no embedded credentials", () => {
    expect(source).not.toMatch(/sk-or-|eyJ[A-Za-z0-9_-]{20,}|service_role|SUPABASE_SECRET|OPENROUTER_API_KEY|BEGIN [A-Z ]*PRIVATE KEY|rdt_[A-Za-z0-9_-]{43}/);
    const hosts = new Set([...source.matchAll(/https?:\/\/([A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+)/g)].map((m) => m[1]));
    for (const h of hosts) expect(["archive.mozilla.org", "download.mozilla.org", "download.windowsupdate.com", "www.catalog.update.microsoft.com", "support.microsoft.com", "www.msftncsi.com"], h as string).toContain(h as string);
  });
  it("uses no PowerShell 3+ only syntax or cmdlets (the PC has PowerShell 2.0 / .NET 2.0)", () => {
    const banned: [string, RegExp][] = [
      ["ConvertTo-Json/ConvertFrom-Json", /ConvertTo-Json|ConvertFrom-Json/],
      ["Invoke-WebRequest/Invoke-RestMethod", /Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b/],
      ["[ordered]", /\[ordered\]/],
      ["[pscustomobject]", /\[pscustomobject\]/i],
      ["$PSScriptRoot", /\$PSScriptRoot/],
      ["Get-Content -Raw", /Get-Content[^|;\n]*-Raw/],
      ["Get-ChildItem -File/-Directory", /Get-ChildItem[^|;\n]*\s-(File|Directory)\b/],
      ["IsNullOrWhiteSpace", /IsNullOrWhiteSpace/],
      ["Is64BitOperatingSystem", /Is64BitOperatingSystem/],
      ["Tls12 enum name", /\bTls1[123]\b/],
      ["Get-CimInstance", /Get-CimInstance|Get-FileHash|Get-NetAdapter|Resolve-DnsName|Test-NetConnection|Expand-Archive|Get-WindowsOptionalFeature/],
      ["-in / -notin operators", /\s-(in|notin)\s/],
      ["comma-less Where-Object shorthand", /\|\s*(\?|where)\s+[A-Za-z_]/i],
      ["::new(", /::new\(/],
      ["class/enum keyword", /^\s*(class|enum)\s+\w+/m],
    ];
    for (const [name, re] of banned) expect(re.test(ps), name).toBe(false);
  });
  it("never invokes the network except through the Http helper and the download ladder", () => {
    expect(ps).not.toMatch(/Invoke-Expression\s+\(?\s*\$?\(?\s*\(?\s*New-Object Net\.WebClient/i);
    expect(ps).not.toMatch(/DownloadString|DownloadFile/);
  });
});

describe("renderScript", () => {
  it("serves CRLF, substitutes only an https relay URL, and hashes the served bytes", () => {
    const a = renderScript(source, "https://relay.example.workers.dev/");
    expect(a.text).toContain("$Relay = 'https://relay.example.workers.dev'");
    expect(a.text.includes("\n") && a.text.split("\n").every((l, i, arr) => i === arr.length - 1 || l.endsWith("\r"))).toBe(true);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const bad of ["http://relay.example", "javascript:alert(1)", "https://x.example/'; calc; '", ""]) expect(renderScript(source, bad).text).toContain("$Relay = ''");
    expect(renderScript(source, "").sha256).not.toBe(a.sha256);
  });
});
