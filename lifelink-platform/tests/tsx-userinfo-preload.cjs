const os = require("node:os");

// TSX reads the account name on Windows; restricted hosts may deny that lookup.
try {
  os.userInfo();
} catch {
  os.userInfo = () => ({
    uid: -1,
    gid: -1,
    username: "lifelink-test",
    homedir: process.env.USERPROFILE ?? ".",
    shell: "",
  });
}
if (typeof process.geteuid !== "function") process.geteuid = () => -1;
