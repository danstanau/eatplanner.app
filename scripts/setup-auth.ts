import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { hashPassword, readAuthConfig } from "../server/auth.js";

let hiding = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!hiding) process.stdout.write(chunk);
    callback();
  },
});
const prompt = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
try {
  const username = (await prompt.question("Super admin name [stanfield]: ")).trim() || "stanfield";
  const publicOrigin = (await prompt.question("App URL (e.g. https://meals.example.com): ")).trim();
  process.stdout.write("Household password (6+ characters, hidden): ");
  hiding = true;
  const password = await prompt.question("");
  process.stdout.write("\nRepeat password: ");
  const repeated = await prompt.question("");
  hiding = false;
  process.stdout.write("\n");
  if (password !== repeated) throw new Error("Passwords do not match.");
  if (!username || username.length > 200 || /[\r\n]/.test(username)) throw new Error("Use a username of 1 to 200 characters on one line.");
  const passwordHash = await hashPassword(password);
  const values = { HOUSEHOLD_USERNAME: username, HOUSEHOLD_PASSWORD_HASH: passwordHash, APP_ORIGIN: publicOrigin };
  readAuthConfig({ ...values, NODE_ENV: process.env.NODE_ENV });
  let contents = "";
  try { contents = await readFile(".env", "utf8"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "gm");
    contents = pattern.test(contents) ? contents.replace(pattern, () => line) : `${contents.trimEnd()}\n${line}\n`;
  }
  await writeFile(".env", contents, { mode: 0o600 });
  await chmod(".env", 0o600);
  console.log("Super admin login configured in .env. Restart the server to enable it.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not configure household login.");
  process.exitCode = 1;
} finally { prompt.close(); }
