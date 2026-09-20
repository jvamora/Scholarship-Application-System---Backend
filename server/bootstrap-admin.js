// Bootstrap admin utility.
// Creates the FIRST administrator account - public registration is staff-only,
// so admin accounts can no longer be minted via /api/auth/register.
// Usage:   npm run bootstrap-admin -- --email admin@school.edu --password secret123 [--first-name A --last-name B]
// Env alt: ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_FIRST_NAME / ADMIN_LAST_NAME

require("dotenv").config();
function argVal(name) {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const email = argVal("email") || process.env.ADMIN_EMAIL;
const password = argVal("password") || process.env.ADMIN_PASSWORD;
const firstName = argVal("first-name") || process.env.ADMIN_FIRST_NAME || "System";
const lastName = argVal("last-name") || process.env.ADMIN_LAST_NAME || "Administrator";

if (!email || !password) { console.error("Missing required credentials."); process.exit(1); }
console.error("Usage: npm run bootstrap-admin -- --email you@example.com --password secret123");
if (String(password).length < 8) { console.error("Password must be at least 8 characters."); process.exit(1); }

(async () => {
  const User = require("./src/models/userModel");
  const existing = await User.findByEmail(email);
  if (existing) { console.error("Email already in use: " + email); process.exit(1); }
  // status approved => loggable immediately; is_first_login 0 => normal login (admin picks own password here)
  const id = await User.create({ email: email, password: password, role: "admin", first_name: firstName, last_name: lastName, status: "approved", is_first_login: 0 });
  const account = await User.findById(id);
  console.log("Bootstrap admin created successfully:");
  console.log("  id:    " + account.id);
  console.log("  email: " + account.email);
  console.log("  role:  " + account.role);
  console.log("Keep this credential safe; clear the env vars after setup.");
  process.exit(0);
})().catch((err) => { console.error("Bootstrap failed: " + err.message); process.exit(1); });
