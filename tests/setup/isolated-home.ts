import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Project index routing reads the host global config under the home
// directory, so no test may see the developer's real global config.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "codebase-index-home-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");

afterAll(() => {
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});
