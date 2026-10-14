import fs from "node:fs";
import bcrypt from "bcryptjs";

// stdin keeps passwords out of process arguments and shell history.
const password = process.argv[2] ?? fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (password.length < 12) {
  console.error("Provide a password of at least 12 characters via stdin.");
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 12));
