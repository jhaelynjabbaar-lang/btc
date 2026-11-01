/**
 * Windows 7 repair helper: the single source of truth for finding ids, action ids and their (human) descriptions.
 * No I/O, no secrets, importable from server code, client components and tests.
 *
 * SECURITY MODEL: the server never sends a command. It can only SUGGEST one of the ACTION_IDS below. The script on the PC maps
 * an id to a command that is embedded in the script itself (see agent/win7-repair/repair.bat, section #ACTIONS), shows the exact
 * command line to the person at the PC and runs it only after a local "Y". tests/repair/parity.test.ts keeps this list, the
 * script and the SQL CHECK constraint identical.
 */

export const FINDING_STATUSES = ["unknown", "ok", "warn", "fail"] as const; // index = 2-bit value in the offline code
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** The first OFFLINE_COUNT ids (in this exact order) are encoded in the offline code. */
export const FINDING_IDS = [
  "os.version",
  "os.sp1",
  "hw.ram",
  "hw.disk",
  "net.adapter",
  "net.ip",
  "net.gateway",
  "net.internet",
  "net.dns",
  "net.proxy_wininet",
  "net.proxy_winhttp",
  "net.hosts",
  "time.skew",
  "tls.schannel12",
  "tls.winhttp_default",
  "tls.dotnet",
  "tls.hotfix",
  "tls.client_probe",
  "tls.root_certs",
  "ie.present",
  "ie.feature",
  "browser.assoc",
  "browser.exe_assoc",
  "browser.policy",
  // not part of the offline code:
  "net.http_plain",
  "net.server",
  "sys.update_service",
  "sys.sha2",
  "sys.clr",
] as const;
export type FindingId = (typeof FINDING_IDS)[number];
export const OFFLINE_COUNT = 24;
export const OFFLINE_ORDER: readonly FindingId[] = FINDING_IDS.slice(0, OFFLINE_COUNT);

export const FINDING_LABEL: Record<FindingId, string> = {
  "os.version": "Windows version",
  "os.sp1": "Service Pack 1",
  "hw.ram": "Memory (RAM)",
  "hw.disk": "Free disk space on C:",
  "net.adapter": "Network adapter",
  "net.ip": "IPv4 address",
  "net.gateway": "Gateway reachable",
  "net.internet": "Internet reachable by IP",
  "net.dns": "DNS name lookup",
  "net.proxy_wininet": "Proxy (Internet Explorer / WinINET)",
  "net.proxy_winhttp": "Proxy (WinHTTP)",
  "net.hosts": "hosts file",
  "time.skew": "Clock accuracy",
  "tls.schannel12": "TLS 1.2 in Windows (SChannel client)",
  "tls.winhttp_default": "TLS 1.2 default in WinHTTP",
  "tls.dotnet": ".NET TLS 1.2 support",
  "tls.hotfix": "TLS hotfixes (KB3140245 / KB3154518)",
  "tls.client_probe": "Script can open TLS 1.2 to a Windows 7-compatible site",
  "tls.root_certs": "Root certificates",
  "ie.present": "Internet Explorer program file",
  "ie.feature": "Internet Explorer Windows feature",
  "browser.assoc": "Web link / .htm file associations",
  "browser.exe_assoc": ".exe file association",
  "browser.policy": "Policies that block programs",
  "net.http_plain": "Plain HTTP works (Microsoft connectivity test)",
  "net.server": "Report server reachable",
  "sys.update_service": "Windows Update service",
  "sys.sha2": "SHA-2 signature update",
  "sys.clr": ".NET / PowerShell versions",
};

export const ACTION_IDS = [
  "flush_dns",
  "renew_ip",
  "reset_winsock",
  "reset_tcpip",
  "reset_winhttp_proxy",
  "clear_ie_proxy",
  "reset_hosts",
  "resync_time",
  "sfc_scan",
  "chkdsk_readonly",
  "enable_tls12_schannel",
  "enable_tls12_winhttp",
  "enable_tls12_dotnet",
  "enable_ie_tls12",
  "enable_ie_feature",
  "reset_url_associations",
  "fix_exe_association",
  "clear_disallowrun",
  "clear_ifeo_debugger",
  "clean_user_temp",
  "download_firefox",
  "install_firefox",
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export type ActionDef = {
  id: ActionId;
  title: string;
  /** What it changes, in plain language (shown to the admin; the PC shows its own text plus the exact commands). */
  changes: string;
  needsAdmin: boolean;
  reboot: boolean;
  /** Findings that make this action relevant. The AI filter only keeps a suggestion when one of these is not "ok". */
  related: readonly FindingId[];
};

export const ACTIONS: readonly ActionDef[] = [
  { id: "flush_dns", title: "Flush DNS cache", changes: "Empties the DNS resolver cache. Nothing is deleted from disk.", needsAdmin: false, reboot: false, related: ["net.dns"] },
  { id: "renew_ip", title: "Release and renew IP address", changes: "Drops the current IPv4 lease and asks the router for a new one. The connection drops for a few seconds.", needsAdmin: true, reboot: false, related: ["net.ip", "net.gateway"] },
  { id: "reset_winsock", title: "Reset Winsock catalog", changes: "Resets the Winsock network catalog to defaults (removes broken network filters). Restart required.", needsAdmin: true, reboot: true, related: ["net.internet", "net.dns", "net.adapter"] },
  { id: "reset_tcpip", title: "Reset TCP/IP stack", changes: "Rewrites TCP/IP registry settings to defaults and writes a log. Static IP settings are cleared. Restart required.", needsAdmin: true, reboot: true, related: ["net.ip", "net.gateway", "net.internet"] },
  { id: "reset_winhttp_proxy", title: "Reset WinHTTP proxy", changes: "Removes the system-wide WinHTTP proxy setting.", needsAdmin: true, reboot: false, related: ["net.proxy_winhttp"] },
  { id: "clear_ie_proxy", title: "Clear Internet Explorer proxy", changes: "Turns off the current user's IE/WinINET proxy and removes the proxy server and auto-config script values.", needsAdmin: false, reboot: false, related: ["net.proxy_wininet"] },
  { id: "reset_hosts", title: "Reset hosts file", changes: "Saves the hosts file as hosts.bak and replaces it with the default (comment-only) file.", needsAdmin: true, reboot: false, related: ["net.hosts"] },
  { id: "resync_time", title: "Resynchronize clock", changes: "Starts the Windows Time service if needed and asks the time server for the correct time.", needsAdmin: true, reboot: false, related: ["time.skew"] },
  { id: "sfc_scan", title: "System File Checker (sfc /scannow)", changes: "Scans protected system files and repairs damaged ones from the Windows component store. Can take 15+ minutes.", needsAdmin: true, reboot: false, related: ["ie.present", "browser.exe_assoc", "browser.assoc"] },
  { id: "chkdsk_readonly", title: "Disk check (read-only)", changes: "Scans the C: drive for errors without fixing anything.", needsAdmin: true, reboot: false, related: ["hw.disk"] },
  { id: "enable_tls12_schannel", title: "Enable TLS 1.2 in Windows (SChannel client)", changes: "Adds two registry values so Windows can use TLS 1.2 as a client. Restart required.", needsAdmin: true, reboot: true, related: ["tls.schannel12", "tls.client_probe"] },
  { id: "enable_tls12_winhttp", title: "Make TLS 1.2 the default in WinHTTP", changes: "Adds the WinHTTP DefaultSecureProtocols registry value (only effective after Windows update KB3140245). Restart required.", needsAdmin: true, reboot: true, related: ["tls.winhttp_default", "tls.hotfix", "tls.client_probe"] },
  { id: "enable_tls12_dotnet", title: "Make .NET use system TLS defaults", changes: "Adds .NET Framework registry values (SystemDefaultTlsVersions, SchUseStrongCrypto) so .NET programs can use TLS 1.2.", needsAdmin: true, reboot: false, related: ["tls.dotnet", "tls.client_probe"] },
  { id: "enable_ie_tls12", title: "Enable TLS 1.2 for Internet Explorer", changes: "Sets the current user's Internet Explorer SecureProtocols value to TLS 1.0 + 1.1 + 1.2.", needsAdmin: false, reboot: false, related: ["tls.schannel12"] },
  { id: "enable_ie_feature", title: "Turn on the Internet Explorer Windows feature", changes: "Uses DISM to enable the Internet Explorer optional feature if it was turned off. Restart may be required.", needsAdmin: true, reboot: true, related: ["ie.feature", "ie.present"] },
  { id: "reset_url_associations", title: "Reset default-browser links for this user", changes: "Removes this user's saved default-program choices for http, https, .htm and .html so Windows asks again.", needsAdmin: false, reboot: false, related: ["browser.assoc"] },
  { id: "fix_exe_association", title: "Repair the .exe file association", changes: "Restores the standard .exe association and open command (assoc/ftype).", needsAdmin: true, reboot: false, related: ["browser.exe_assoc"] },
  { id: "clear_disallowrun", title: "Remove 'run only allowed programs' policy", changes: "Backs up the Explorer policy keys to your Desktop, then removes the DisallowRun block list.", needsAdmin: false, reboot: false, related: ["browser.policy"] },
  { id: "clear_ifeo_debugger", title: "Remove program-launch hijacks for browsers", changes: "Backs up the Image File Execution Options key to your Desktop, then removes any Debugger value for iexplore, firefox, chrome and msedge.", needsAdmin: true, reboot: false, related: ["browser.policy"] },
  { id: "clean_user_temp", title: "Delete temporary files", changes: "Deletes files inside your own TEMP folder to free disk space. Files in use are skipped.", needsAdmin: false, reboot: false, related: ["hw.disk"] },
  { id: "download_firefox", title: "Download Firefox ESR 115", changes: "Looks for a USB copy first, otherwise downloads the official installer to the RepairHelper folder on your Desktop and checks its SHA-256 against the value built into the script. Does not install it.", needsAdmin: false, reboot: false, related: ["ie.present", "ie.feature", "browser.assoc", "browser.policy", "browser.exe_assoc", "tls.client_probe"] },
  { id: "install_firefox", title: "Install Firefox ESR 115", changes: "Starts the checked Firefox installer (normal windows, you click through it).", needsAdmin: false, reboot: false, related: ["ie.present", "ie.feature", "browser.assoc", "browser.policy", "browser.exe_assoc", "tls.client_probe"] },
];

export const ACTION_BY_ID: Record<ActionId, ActionDef> = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<ActionId, ActionDef>;

export function isActionId(v: unknown): v is ActionId {
  return typeof v === "string" && (ACTION_IDS as readonly string[]).includes(v);
}
export function isFindingId(v: unknown): v is FindingId {
  return typeof v === "string" && (FINDING_IDS as readonly string[]).includes(v);
}

/** Official Firefox ESR 115 (last Firefox for Windows 7). Verified 2026-11-01: SHA-256 matches Mozilla's SHA256SUMS. */
export const FIREFOX = {
  version: "115.44.0esr",
  url: "https://archive.mozilla.org/pub/firefox/releases/115.44.0esr/win64/en-US/Firefox%20Setup%20115.44.0esr.exe",
  sha256: "1561f9eaf625804b13c584022bcceb0baff356173a804b39b9b06cfaef875fc2",
  sumsUrl: "https://archive.mozilla.org/pub/firefox/releases/115.44.0esr/SHA256SUMS",
} as const;
