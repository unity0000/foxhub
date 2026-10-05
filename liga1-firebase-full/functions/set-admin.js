const admin = require("firebase-admin");
admin.initializeApp();

const uid = process.argv[2];
if (!uid) {
  console.error("Usage: node set-admin.js FIREBASE_AUTH_UID");
  process.exit(1);
}

admin.auth().setCustomUserClaims(uid, { admin: true })
  .then(() => {
    console.log(`Admin claim granted to ${uid}. Sign out and sign in again to refresh the ID token.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
