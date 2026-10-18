const SCHEMES = ["smb", "sftp", "ssh", "ftp", "ftps", "dav", "davs", "afp", "nfs"];

/** Mirrors the backend's normalisation: a bare host is smb://host, `\\host\share` too. */
export function normalizeAddress(input: string): { uri: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "Enter a server address, for example smb://nas/photos" };
  if (/\s/.test(text)) return { error: "The address cannot contain spaces" };
  if (text.startsWith("\\\\")) return normalizeAddress(`smb://${text.slice(2).replace(/\\/g, "/")}`);
  const at = text.indexOf("://");
  if (at < 0) return normalizeAddress(`smb://${text}`);
  let scheme = text.slice(0, at).toLowerCase();
  const rest = text.slice(at + 3);
  if (scheme === "ssh") scheme = "sftp";
  if (!SCHEMES.includes(scheme)) return { error: `"${scheme}" addresses are not supported` };
  if (!rest.replace(/^\/+|\/+$/g, "")) return { error: "The address is missing a server name" };
  return { uri: `${scheme}://${rest}` };
}

export const schemeOf = (uri: string) => uri.slice(0, Math.max(0, uri.indexOf("://"))).toLowerCase();

const trimUri = (uri: string) => uri.replace(/\/+$/, "").toLowerCase();

/** Whether a saved address lives on (or at) the mounted location. */
export function addressOnMount(address: string, mountUri: string): boolean {
  const a = trimUri(address);
  const m = trimUri(mountUri);
  return a === m || a.startsWith(`${m}/`);
}

/** The part of a saved address below the mount root, decoded ("" for the root itself). */
export function subPath(address: string, mountUri: string): string {
  if (!addressOnMount(address, mountUri)) return "";
  const rest = address.replace(/\/+$/, "").slice(mountUri.replace(/\/+$/, "").length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}
