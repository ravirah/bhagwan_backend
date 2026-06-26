const bcrypt = require('bcryptjs');

// The admin password lives in the AdminCredential table (single row), hashed with bcrypt.
// It is SEEDED once from the env vars (ADMIN_USERNAME / ADMIN_PASSWORD) so existing logins
// keep working unchanged, and can then be changed in-app.
//
// RECOVERY / NO LOCKOUT: the env-var password (ADMIN_PASSWORD) ALWAYS works as a master
// recovery password, even after an in-app change. So if the admin forgets the in-app
// password they can still sign in with the original Render env password (or just change
// ADMIN_PASSWORD in the Render dashboard and use that). There is no way to get locked out.
async function getOrSeedAdminCredential(models, dbFactory) {
  const { AdminCredential } = models;
  if (!AdminCredential) return null;
  let cred = dbFactory.isMongoDB() ? await AdminCredential.findOne({}) : await AdminCredential.findOne();
  if (!cred) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin', 10);
    cred = await AdminCredential.create({ username, passwordHash });
  }
  return cred;
}

// Returns true if (username, password) is valid against EITHER the stored DB credential
// OR the env master credential. Used by login and by change-password's current-password check.
async function verifyAdminLogin(models, dbFactory, username, password) {
  const u = (username || '').trim();
  const p = password || '';

  // Path 1: env master / recovery credential — always valid, never lockable.
  const envUser = process.env.ADMIN_USERNAME || 'admin';
  const envPass = process.env.ADMIN_PASSWORD || '';
  if (envPass && u === envUser && p === envPass) return true;

  // Path 2: stored (in-app changeable) credential.
  const cred = await getOrSeedAdminCredential(models, dbFactory);
  if (cred && u === cred.username) {
    try {
      if (await bcrypt.compare(p, cred.passwordHash)) return true;
    } catch (_) { /* ignore malformed hash */ }
  }
  return false;
}

async function setAdminPassword(models, dbFactory, newPassword) {
  const cred = await getOrSeedAdminCredential(models, dbFactory);
  const passwordHash = await bcrypt.hash(newPassword, 10);
  if (dbFactory.isMongoDB()) {
    cred.passwordHash = passwordHash;
    await cred.save();
  } else {
    await cred.update({ passwordHash });
  }
  return cred;
}

module.exports = { bcrypt, getOrSeedAdminCredential, verifyAdminLogin, setAdminPassword };
