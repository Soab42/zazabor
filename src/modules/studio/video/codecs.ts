import { errorText } from "../../time/api";
import { ask } from "../photo/ask";
import { editApi, type Encoders } from "./api";

const PACKAGE_WHAT: Record<string, string> = {
  "gstreamer1.0-libav": "AAC sound, and phones' sound and video",
  "gstreamer1.0-plugins-ugly": "the x264 encoder",
  "gstreamer1.0-plugins-bad": "HEVC (x265) and more decoders",
};

/**
 * "Install codecs": explains what the packages add, then installs them with the system's
 * password prompt. Resolves with the new encoders, or null when cancelled or it failed.
 */
export async function offerCodecInstall(packages: string[], toast: (text: string) => void): Promise<Encoders | null> {
  if (!packages.length) return null;
  const named = packages.map((p) => `${p} (${PACKAGE_WHAT[p] ?? "codecs"})`);
  const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : named[0];
  const answer = await ask({
    title: "Install codecs?",
    text: `Zazabor will install ${list} from your system's software sources. Your password is asked for by the system, not by Zazabor. It takes a minute and needs the internet.`,
    icon: "download",
    choices: [{ id: "no", label: "Not Now" }, { id: "yes", label: "Install", primary: true }],
    cancel: "no",
  });
  if (answer !== "yes") return null;
  toast("Installing codecs… the system asks for your password.");
  try {
    const encoders = await editApi.installCodecs(packages);
    const still = packages.filter((p) => encoders.missing.includes(p));
    const added = [encoders.aac ? "AAC sound" : "", encoders.codecs.some((c) => c.id === "x264" && c.available) ? "x264" : "", encoders.hevc ? "HEVC" : ""].filter(Boolean);
    if (still.length) toast("The installer finished, but the codecs don't show up yet. Restart Zazabor.");
    else toast(added.length ? `Codecs installed: ${added.join(", ")} ready.` : "Codecs installed.");
    return encoders;
  } catch (err) {
    toast(errorText(err));
    return null;
  }
}
