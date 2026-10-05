const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "asia-south1", maxInstances: 10 });

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function requireAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
  return request.auth.uid;
}

function requireAdmin(request) {
  const uid = requireAuth(request);
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
  return uid;
}

function cleanString(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function positiveNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

exports.ensureUserProfile = onCall(async (request) => {
  const uid = requireAuth(request);
  const user = request.auth.token;
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.create({
      uid,
      email: user.email || "",
      displayName: user.name || "Free Fire Player",
      photoURL: user.picture || "",
      freeFireUID: "",
      freeFireNickname: "",
      balance: 0,
      earnings: 0,
      pendingWithdrawal: 0,
      accountStatus: "active",
      isBanned: false,
      createdAt: FieldValue.serverTimestamp(),
      lastLoginAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  } else {
    await ref.update({
      email: user.email || snap.data().email || "",
      displayName: user.name || snap.data().displayName || "Free Fire Player",
      photoURL: user.picture || snap.data().photoURL || "",
      lastLoginAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  const latest = await ref.get();
  const data = latest.data();
  if (data.isBanned || data.accountStatus === "banned") {
    throw new HttpsError("permission-denied", "This account has been blocked by Liga1 administration.");
  }
  return { ...data, uid };
});

exports.updateFreeFireProfile = onCall(async (request) => {
  const uid = requireAuth(request);
  const nickname = cleanString(request.data?.freeFireNickname, 50);
  const freeFireUID = cleanString(request.data?.freeFireUID, 30);
  if (!nickname || !freeFireUID) {
    throw new HttpsError("invalid-argument", "Free Fire nickname and UID are required.");
  }
  if (!/^\d{5,15}$/.test(freeFireUID)) {
    throw new HttpsError("invalid-argument", "Free Fire UID must contain 5-15 digits.");
  }
  await db.collection("users").doc(uid).update({
    freeFireNickname: nickname,
    freeFireUID,
    updatedAt: FieldValue.serverTimestamp()
  });
  return { ok: true };
});

exports.submitDeposit = onCall(async (request) => {
  const uid = requireAuth(request);
  const amount = positiveNumber(request.data?.amount);
  const paymentReference = cleanString(request.data?.paymentReference, 120);
  const paymentMethod = cleanString(request.data?.paymentMethod, 40);

  if (!amount || amount < 20) throw new HttpsError("invalid-argument", "Minimum deposit is 20 coins.");
  if (!paymentReference) throw new HttpsError("invalid-argument", "Payment reference is required.");
  if (!paymentMethod) throw new HttpsError("invalid-argument", "Payment method is required.");

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) throw new HttpsError("failed-precondition", "User profile does not exist.");
  const user = userSnap.data();
  if (user.isBanned || user.accountStatus !== "active") throw new HttpsError("permission-denied", "Account is not active.");

  const duplicate = await db.collection("depositRequests")
    .where("paymentReference", "==", paymentReference)
    .limit(1).get();
  if (!duplicate.empty) throw new HttpsError("already-exists", "This payment reference has already been submitted.");

  const ref = db.collection("depositRequests").doc();
  await ref.set({
    id: ref.id,
    uid,
    email: user.email || request.auth.token.email || "",
    amount,
    paymentMethod,
    paymentReference,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
  return { requestId: ref.id, status: "pending" };
});

exports.requestWithdrawal = onCall(async (request) => {
  const uid = requireAuth(request);
  const amount = positiveNumber(request.data?.amount);
  const wallet = cleanString(request.data?.wallet, 40);
  const accountId = cleanString(request.data?.accountId, 100);

  if (!amount || amount < 200) throw new HttpsError("invalid-argument", "Minimum withdrawal is 200 coins.");
  if (!wallet || !accountId) throw new HttpsError("invalid-argument", "Wallet and account ID are required.");

  const userRef = db.collection("users").doc(uid);
  const requestRef = db.collection("withdrawalRequests").doc();
  const txRef = db.collection("transactions").doc();

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("failed-precondition", "User profile does not exist.");
    const user = userSnap.data();
    if (user.isBanned || user.accountStatus !== "active") throw new HttpsError("permission-denied", "Account is not active.");

    const earnings = Number(user.earnings || 0);
    if (earnings < amount) throw new HttpsError("failed-precondition", "Insufficient available earnings.");

    tx.update(userRef, {
      earnings: earnings - amount,
      pendingWithdrawal: Number(user.pendingWithdrawal || 0) + amount,
      updatedAt: FieldValue.serverTimestamp()
    });

    tx.set(requestRef, {
      id: requestRef.id,
      uid,
      email: user.email || request.auth.token.email || "",
      amount,
      wallet,
      accountId,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    tx.set(txRef, {
      id: txRef.id,
      uid,
      type: "withdrawal_reserved",
      description: `Withdrawal reserved: ${wallet}`,
      amount: -amount,
      status: "Pending",
      withdrawalRequestId: requestRef.id,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { requestId: requestRef.id, status: "pending" };
});

exports.adminApproveDeposit = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const requestId = cleanString(request.data?.requestId, 100);
  if (!requestId) throw new HttpsError("invalid-argument", "Deposit request ID is required.");

  const requestRef = db.collection("depositRequests").doc(requestId);
  const adminRef = db.collection("users").doc(adminUid);
  await db.runTransaction(async (tx) => {
    const [reqSnap, adminSnap] = await Promise.all([tx.get(requestRef), tx.get(adminRef)]);
    if (!reqSnap.exists) throw new HttpsError("not-found", "Deposit request not found.");
    const req = reqSnap.data();
    if (req.status !== "pending") throw new HttpsError("failed-precondition", "Deposit is no longer pending.");
    const userRef = db.collection("users").doc(req.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "Player account not found.");
    const user = userSnap.data();
    const txRef = db.collection("transactions").doc();

    tx.update(userRef, {
      balance: Number(user.balance || 0) + Number(req.amount || 0),
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(requestRef, {
      status: "approved",
      approvedBy: adminUid,
      approvedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.set(txRef, {
      id: txRef.id,
      uid: req.uid,
      type: "deposit",
      description: `Deposit approved via ${req.paymentMethod}`,
      amount: Number(req.amount || 0),
      status: "Approved",
      depositRequestId: requestId,
      approvedBy: adminUid,
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { ok: true };
});

exports.adminDenyDeposit = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const requestId = cleanString(request.data?.requestId, 100);
  const reason = cleanString(request.data?.reason, 250) || "Payment could not be verified.";
  if (!requestId) throw new HttpsError("invalid-argument", "Deposit request ID is required.");

  const ref = db.collection("depositRequests").doc(requestId);
  await ref.update({ status: "denied", deniedBy: adminUid, denialReason: reason, deniedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

exports.adminApproveWithdrawal = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const requestId = cleanString(request.data?.requestId, 100);
  if (!requestId) throw new HttpsError("invalid-argument", "Withdrawal request ID is required.");

  const requestRef = db.collection("withdrawalRequests").doc(requestId);
  await db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(requestRef);
    if (!reqSnap.exists) throw new HttpsError("not-found", "Withdrawal request not found.");
    const req = reqSnap.data();
    if (req.status !== "pending") throw new HttpsError("failed-precondition", "Withdrawal is no longer pending.");
    const userRef = db.collection("users").doc(req.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "Player account not found.");
    const user = userSnap.data();

    tx.update(userRef, {
      pendingWithdrawal: Math.max(0, Number(user.pendingWithdrawal || 0) - Number(req.amount || 0)),
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(requestRef, {
      status: "paid",
      approvedBy: adminUid,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    const txRef = db.collection("transactions").doc();
    tx.set(txRef, {
      id: txRef.id,
      uid: req.uid,
      type: "withdrawal_paid",
      description: `Withdrawal paid via ${req.wallet}`,
      amount: -Number(req.amount || 0),
      status: "Paid",
      withdrawalRequestId: requestId,
      approvedBy: adminUid,
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { ok: true };
});

exports.adminDenyWithdrawal = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const requestId = cleanString(request.data?.requestId, 100);
  const reason = cleanString(request.data?.reason, 250) || "Withdrawal was denied.";
  if (!requestId) throw new HttpsError("invalid-argument", "Withdrawal request ID is required.");

  const requestRef = db.collection("withdrawalRequests").doc(requestId);
  await db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(requestRef);
    if (!reqSnap.exists) throw new HttpsError("not-found", "Withdrawal request not found.");
    const req = reqSnap.data();
    if (req.status !== "pending") throw new HttpsError("failed-precondition", "Withdrawal is no longer pending.");
    const userRef = db.collection("users").doc(req.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "Player account not found.");
    const user = userSnap.data();
    const amount = Number(req.amount || 0);

    tx.update(userRef, {
      earnings: Number(user.earnings || 0) + amount,
      pendingWithdrawal: Math.max(0, Number(user.pendingWithdrawal || 0) - amount),
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(requestRef, {
      status: "denied",
      deniedBy: adminUid,
      denialReason: reason,
      deniedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    const txRef = db.collection("transactions").doc();
    tx.set(txRef, {
      id: txRef.id,
      uid: req.uid,
      type: "withdrawal_refund",
      description: "Withdrawal denied and coins returned",
      amount,
      status: "Refunded",
      withdrawalRequestId: requestId,
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { ok: true };
});

exports.adminSetPaymentSettings = onCall(async (request) => {
  const adminUid = requireAdmin(request);
  const qrImageUrl = cleanString(request.data?.qrImageUrl, 1000);
  const instructions = cleanString(request.data?.instructions, 1000);
  const methods = Array.isArray(request.data?.methods) ? request.data.methods.map(x => cleanString(x, 40)).filter(Boolean).slice(0, 10) : [];
  if (!qrImageUrl) throw new HttpsError("invalid-argument", "QR image URL is required.");
  await db.collection("settings").doc("payment").set({
    qrImageUrl,
    instructions,
    methods,
    updatedBy: adminUid,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true };
});
