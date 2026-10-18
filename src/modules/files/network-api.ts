import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The contract between the Files sidebar and the Rust phones-and-network backend
 * (src-tauri/src/fs/mounts.rs, GIO/GVfs). Command names and shapes must match the Rust side.
 */

export type MountKind = "disk" | "usb" | "phone" | "network" | "cloud";

export interface Mount {
  name: string;
  kind: MountKind;
  /** Local (FUSE or real) path; "" while not mounted. */
  path: string;
  /** smb://…, mtp://…, google-drive://… */
  uri: string;
  mounted: boolean;
  canEject: boolean;
  canUnmount: boolean;
  /** Bytes; 0 when unknown (only measured for local disks). */
  total: number;
  free: number;
  /** Phones: known but exposing no storage (locked, or not in File transfer mode). */
  locked: boolean;
}

export interface Credentials {
  username?: string;
  domain?: string;
  password?: string;
  remember?: boolean;
}

export const networkApi = {
  mounts: () => invoke<Mount[]>("fs_mounts"),
  /** Rejects with a message starting `auth:` when credentials are needed or were wrong. */
  mount: (uri: string, creds: Credentials = {}) =>
    invoke<Mount>("fs_mount_uri", {
      uri,
      username: creds.username || null,
      domain: creds.domain || null,
      password: creds.password ?? null,
      remember: creds.remember === true,
    }),
  unmount: (uriOrPath: string) => invoke<void>("fs_unmount", { uriOrPath }),
  eject: (uriOrPath: string) => invoke<void>("fs_eject", { uriOrPath }),
};

/** Fires when a mount, volume or drive appears, changes or goes away. */
export function onMountsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("fs-mounts-changed", () => handler());
}

const AUTH = "auth:";

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const isAuthError = (err: unknown) => errorText(err).startsWith(AUTH);
/** The message without the `auth:` marker. */
export const authMessage = (err: unknown) => errorText(err).slice(AUTH.length).trim();
