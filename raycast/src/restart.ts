import { showHUD, getPreferenceValues, showToast, Toast } from "@raycast/api";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

interface Preferences {
  launchdLabel: string;
}

export default async function Restart() {
  const { launchdLabel } = getPreferenceValues<Preferences>();

  await showToast({ style: Toast.Style.Animated, title: "Restarting daemon…" });

  try {
    await exec("/bin/launchctl", ["stop", launchdLabel]);
    await exec("/bin/launchctl", ["start", launchdLabel]);
    await showHUD(`✅ Restarted ${launchdLabel}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await showToast({
      style: Toast.Style.Failure,
      title: "Restart failed",
      message: msg,
    });
  }
}
