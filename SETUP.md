# SqueegeeHQ — Setup Guide

This app is plain HTML/JS — no build tools, no coding required to get it running. You just need two free accounts (Firebase and Google Cloud) and about 15 minutes.

## What you're setting up
- **Firebase** — the live database. This is what makes your schedule/jobs/map sync instantly between your phone and every tech's phone.
- **Google Maps** — powers the door-to-door sales map.

## Part 1 — Firebase (free)

1. Go to console.firebase.google.com and sign in with a Google account.
2. Click **Add project**, name it (e.g. "SqueegeeHQ"), skip Google Analytics, click **Create project**.
3. In the left sidebar, click **Build → Firestore Database → Create database**. Choose **Start in production mode**, pick a location, click **Enable**.
4. Click **Build → Storage → Get started**. Accept the defaults, click **Done**. (This stores the house photos.)
5. Click **Build → Authentication → Get started**. Under **Sign-in method**, enable **Anonymous**, click **Save**. (This just lets the app securely read/write your data — nobody sees a login screen for this.)
6. Click the **⚙️ gear icon → Project settings**. Scroll to "Your apps," click the **</>** (web) icon, nickname it "SqueegeeHQ," click **Register app**. You'll see a `firebaseConfig` object — copy those values.
7. Open **firebase-config.js** in this folder and paste your values into `FIREBASE_CONFIG`.

### Lock down your database (2 minutes, important)
In Firestore → **Rules** tab, replace the rules with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Do the same in Storage → **Rules**:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Click **Publish** on both. This keeps random strangers off your data while letting the app itself (and anyone who opens the app) work normally — good for a small crew tool. If you ever want tighter security (e.g. real per-person logins), that's a future upgrade, not required to launch.

## Part 2 — Google Maps API key (free tier is generous)

1. Go to console.cloud.google.com — you can use the same project Firebase created for you (it shows up automatically), or pick it from the project dropdown at the top.
2. Go to **APIs & Services → Library**. Search for and **Enable**:
   - Maps JavaScript API
   - Geocoding API
3. Go to **APIs & Services → Credentials → Create Credentials → API key**. Copy the key.
4. (Recommended) Click the key to edit it → under "Application restrictions" choose **Websites** and add the web address you'll host this app on, once you have it (step below). This stops other sites from using your key.
5. Open **firebase-config.js** and paste the key into `GOOGLE_MAPS_API_KEY`.

Google requires a billing account on file for Maps API, but includes $200/month free usage — for one crew logging doors and viewing a schedule, you will not be charged.

## Part 3 — Put it online

This needs to be served over `https://` (not just opened as a local file) for the "Add to Home Screen" install and camera photo upload to work reliably. Easiest free option, since you already have a Firebase project:

1. Install Node.js if you don't have it, then in a terminal: `npm install -g firebase-tools`
2. `firebase login`
3. In this folder: `firebase init hosting` → pick your project → set the public folder to `.` (current folder) → say **No** to single-page rewrite → say **No** to overwriting index.html.
4. `firebase deploy`
5. You'll get a URL like `https://squeegeehq-xxxx.web.app` — that's your app's address.

(Any static host works too — Netlify, Vercel, GitHub Pages — Firebase Hosting is just the path of least resistance since you already have the account.)

## Part 4 — Install it on iPhone like a real app

1. On the iPhone, open the URL from Part 3 in **Safari** (must be Safari, not Chrome).
2. Tap the **Share** icon (square with an arrow) → **Add to Home Screen** → **Add**.
3. A SqueegeeHQ icon appears on the home screen and opens full-screen, no browser bar — feels like a native app.
4. Do this on your phone and on each tech's phone.

## Day one

1. Open the app, tap **I'm the Owner**, create your business name and a passcode.
2. Go to **Team**, add each cleaning tech (name, phone, starting commission is pre-filled at 20%, a login passcode is auto-generated — text it to them).
3. Each tech opens the app on their phone, taps **I'm a Cleaning Tech**, picks their name, enters that passcode.
4. You're live — the **Map** tab is where you log doors while going street to street; **Calendar** is the shared schedule everyone sees in real time.

---

Questions or something not syncing? Double-check `firebase-config.js` has no `PASTE_ME` left in it — that's the #1 thing that blocks the app from loading.
