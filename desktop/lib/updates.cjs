const { verifyUpdateSignature } = require("./update-signature.cjs");
class Updates {
  constructor({ updater, publisher, enabled = false, onChange = () => {} }) {
    Object.assign(this, { updater, publisher, onChange });
    this.value = {
      status: publisher && updater ? "idle" : "unavailable",
      message:
        publisher && updater
          ? "Updates have not been checked."
          : "Automatic updates require a signed installed build. Download previews from GitHub Releases.",
    };
    if (!updater || !publisher) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.verifyUpdateCodeSignature = (_publishers, file) =>
      verifyUpdateSignature(publisher, file);
    updater.on("checking-for-update", () =>
      this.set("checking", "Checking GitHub Releases…"),
    );
    updater.on("update-available", (info) =>
      this.set(
        "available",
        `Ocelin ${info.version} is available.`,
        info.version,
      ),
    );
    updater.on("update-not-available", () =>
      this.set("current", "You have the latest stable release."),
    );
    updater.on("download-progress", (progress) =>
      this.set(
        "downloading",
        `Downloading update: ${Math.floor(progress.percent)}%`,
      ),
    );
    updater.on("update-downloaded", (info) =>
      this.set(
        "ready",
        `Ocelin ${info.version} is ready. Restart to install.`,
        info.version,
      ),
    );
    updater.on("error", () =>
      this.set(
        "error",
        "Update could not be verified or downloaded. Try again later.",
      ),
    );
    this.configure(enabled);
  }
  set(status, message, version = this.value.version) {
    this.value = { status, message, version };
    this.onChange(this.value);
  }
  configure(enabled) {
    clearInterval(this.timer);
    if (!this.updater || !this.publisher) return;
    this.updater.autoDownload = Boolean(enabled);
    this.updater.autoInstallOnAppQuit = Boolean(enabled);
    if (enabled) {
      void this.check().catch(() => {});
      this.timer = setInterval(
        () => void this.check().catch(() => {}),
        6 * 3600000,
      );
      this.timer.unref();
    }
  }
  async verifyConfiguration() {
    if (!this.updater || !this.publisher) throw new Error(this.value.message);
    const config = await this.updater.configOnDisk.value;
    const publishers = Array.isArray(config.publisherName)
      ? config.publisherName
      : [config.publisherName];
    if (
      config.provider !== "github" ||
      config.owner !== "m-sanchez" ||
      config.repo !== "ocelin" ||
      publishers.length !== 1 ||
      publishers[0] !== this.publisher
    )
      throw new Error(
        "Update publisher or feed does not match this signed build",
      );
  }
  async check() {
    if (this.busy || ["downloading", "ready"].includes(this.value.status))
      return this.value;
    this.busy = true;
    try {
      await this.verifyConfiguration();
      await this.updater.checkForUpdates();
      return this.value;
    } catch (error) {
      if (this.value.status !== "unavailable")
        this.set("error", "Could not check a verified update feed.");
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async download() {
    if (this.value.status !== "available")
      throw new Error("Check for an available update first");
    await this.verifyConfiguration();
    this.set("downloading", "Downloading verified update…");
    await this.updater.downloadUpdate();
    return this.value;
  }
  install() {
    if (this.value.status !== "ready")
      throw new Error("No verified update is ready");
    this.updater.quitAndInstall(false, true);
  }
  stop() {
    clearInterval(this.timer);
  }
}
module.exports = { Updates };
