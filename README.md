# Selftape

A minimal music player for your own music. It runs as a web app on your iPhone (no App Store, no Apple developer account), syncs through your own free cloud storage, and has a private Telegram bot that adds anything you send it to your library.

```
docs/     the app (hosted free on GitHub Pages)
worker/   the server: Cloudflare Worker + R2 storage + Telegram bot
```

## What it does

- Library with search and sorting, playlists, queue, shuffle, repeat
- Lock-screen and AirPods controls
- Offline: tracks are saved on the phone and play with no internet
- Cloud sync: your library and playlists are the same on every device
- Telegram: send or forward audio to your bot and it shows up in the app. A caption sets the title.
- Import: Telegram → **Save to Files** → app → **Import** (for files over 20 MB)

## Setup (about 20 minutes, once)

### 1. Make the Telegram bot
1. In Telegram, message **@BotFather** and send `/newbot`.
2. Pick a name and a username. BotFather replies with a **token** (`123456:ABC...`). Keep it secret.

### 2. Put the server on Cloudflare (free)
1. Make a free account at cloudflare.com. In the dashboard, open **R2** and turn it on. Cloudflare may ask for a card even on the free plan, which covers 10 GB of storage.
2. On your PC, in the `worker` folder:

```powershell
cd worker
npm install
npx wrangler login
npx wrangler r2 bucket create selftape
```

3. Make an app password. Use something long and random. This command prints one:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

4. Store the secrets. Each command asks you to paste a value.

```powershell
npx wrangler secret put APP_TOKEN
```
```powershell
npx wrangler secret put BOT_TOKEN
```

5. Deploy:

```powershell
npx wrangler deploy
```

It prints your server URL, something like `https://selftape-api.yourname.workers.dev`.

### 3. Put the app on GitHub Pages (free)
1. Make a new GitHub repo and push this folder to it.
2. In the repo, go to **Settings → Pages**. Set Source to **Deploy from a branch**, choose `main`, choose the folder **/docs**, and save.
3. After a minute, the app is at `https://YOUR-NAME.github.io/REPO-NAME/`.

Only the app's code goes on GitHub. Your music lives in your private R2 bucket.

### 4. Set it up on your iPhone
1. Open the Pages link in **Safari**, tap **Share → Add to Home Screen**, and open the app from your home screen.
2. Go to **Settings**, paste the server URL and app password, and tap **Save & sync**.
3. Tap **Connect bot**, then **Open Telegram**, then **Start**. The bot replies "Connected". After that, only you can use it.

You're done. Send the bot a track, then tap the sync button or reopen the app, and it's there.

## Good to know
- **Bot file limit:** 20 MB, which Telegram sets. For bigger WAV or FLAC files, use Save to Files → Import.
- **Voice messages** use the Ogg format, which may not play on some iPhones. Normal audio files (MP3, M4A, WAV, FLAC, AIFF) all work.
- **Updating the app:** after you change files in `docs/`, bump `VERSION` in `docs/sw.js` so phones pick up the new version.
- **Optional lock-down:** in `worker/wrangler.toml`, uncomment `ALLOWED_ORIGIN` and set it to your Pages address, so only your site can call the server.
- **Local testing:** run `npx wrangler dev` in `worker/` and serve `docs/` with any static server.
