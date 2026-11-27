# Selftape

A minimal music player for your own music. It runs as a web app on your iPhone (no App Store, no Apple developer account). Your audio files live in your own Telegram channel, which is free with no storage limit, and a small free Cloudflare server keeps your library and playlists in sync.

```
docs/     the app: https://selftape.selftape-api.workers.dev/
site/     deploys docs/ to its own address (cd site; npx --prefix ../worker wrangler deploy)
worker/   the server (Cloudflare Worker + D1 database) and the Telegram bot
```

## How it works
- **Post a track in your music channel** and it shows up in Selftape.
- **Send or forward audio to the bot** and it gets added and copied into the channel. Duplicates are skipped.
- **Import a file in the app** and it gets uploaded into the channel.
- Tracks download to the phone and play offline, with lock-screen and AirPods controls.
- **Deleting a track in Selftape** never deletes anything in Telegram.
- **Limit:** 20 MB per file, because Telegram bots can't download bigger files. Bigger imports stay on that one phone only.

## Setup
1. **Bot:** in Telegram, message @BotFather, send `/newbot`, and copy the token.
2. **Server:** run these in `worker/`:
   ```powershell
   npm install
   npx wrangler login
   npx wrangler d1 create selftape
   ```
   Put the `database_id` from the output into `wrangler.toml`. Then run:
   ```powershell
   npx wrangler deploy
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put APP_TOKEN
   ```
   `APP_TOKEN` is a password you make up. The app uses it to talk to the server.
3. **App:** in `site/`, run `npx --prefix ../worker wrangler deploy`. The app needs its own address: iPhone treats all web apps on one address (like username.github.io) as the same app.
4. **iPhone:** open the Pages link in Safari, tap Share → Add to Home Screen. In Settings, enter the server URL and app password, then tap **Connect bot** and press Start in Telegram.
5. **Channel:** add the bot as an admin of your music channel. The bot confirms in Telegram. To add old tracks, forward them to the bot.

## Good to know
- After changing anything in `docs/`, bump `VERSION` in `docs/sw.js` so phones pick up the new version.
- Bot commands: `/status` shows the track count and the linked channel.
