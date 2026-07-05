const fs = require("fs-extra");
const path = require("node:path");
const { LOG_DIR, formatNowIso } = require("./helpers.js");

class Logger {
  constructor(filePath = path.join(LOG_DIR, "scraper.log")) {
    this.filePath = filePath;
  }

  async init() {
    await fs.ensureDir(path.dirname(this.filePath));
    await fs.ensureFile(this.filePath);
  }

  async info(message) {
    await this.write("INFO", message);
  }

  async warn(message) {
    await this.write("WARN", message);
  }

  async error(message) {
    await this.write("ERROR", message);
  }

  async write(level, message) {
    const line = `[${formatNowIso()}] [${level}] ${message}`;
    console.log(line);
    await fs.appendFile(this.filePath, `${line}\n`, "utf8");
  }
}

module.exports = {
  Logger
};
