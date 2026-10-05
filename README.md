# Liga1 Esports - Firebase V1

This version keeps the existing Liga1 navigation/UI and adds real Firebase Google Authentication.

## Included in V1

- Google-only Firebase Authentication
- Persistent Firebase UID
- Firestore user profile
- Free Fire nickname + UID saved to Firestore
- No fake starting balance
- Deposit creates a pending admin-review request
- Withdrawal creates a pending admin-review request
- Client cannot directly change balance/earnings
- Firestore rules for the first-stage security boundary
- Real-time transaction ledger listener

## Firebase Console setup

1. Create a Firebase project.
2. Add a Web App.
3. Copy its Firebase config into `index.html`.
4. Authentication -> Sign-in method -> enable Google.
5. Authentication -> Settings -> Authorized domains:
   add your GitHub Pages domain, for example `YOURNAME.github.io`.
6. Create Firestore Database.
7. Publish `firestore.rules`.

## Important

The payment QR and admin approval workflow still need the next backend phase.

Do NOT make the browser update:
- users.balance
- users.earnings
- users.pendingWithdrawal
- transactions

The next phase should add Firebase Cloud Functions for:
- deposit approval
- withdrawal reservation
- withdrawal approval/denial
- room creation
- room joining / entry-fee deduction
- prize distribution
- admin authorization

Payment provider private credentials and service-account keys must never be committed to GitHub.

## GitHub Pages

For the frontend:
  index.html -> GitHub repository -> Settings -> Pages -> Deploy from branch

Firebase handles Auth/Firestore. GitHub Pages only hosts the frontend.
