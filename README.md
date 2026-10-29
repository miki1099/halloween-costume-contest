# 🎃 Halloween Costume Contest

Mobile web app for a one-night costume contest. Guests snap a photo of their costume from their phone, the host opens voting, everyone votes for their favourite, and the host reveals the winner.

## Run

```bash
docker compose up -d --build
```

- Guests: `http://<host>:8096` (on a laptop find the LAN IP with `ipconfig getifaddr en0`; turn it into a QR code for the door)
- Host: `http://<host>:8096/admin`, password `Haloween2026` unless overridden in `.env`

## Exposing it to the internet

1. `cp .env.example .env` and set a long `ADMIN_PASSWORD`.
2. Put it behind HTTPS. With Caddy on the same host, set `BIND_ADDRESS=127.0.0.1` and `TRUST_PROXY=true` in `.env`, then:
   ```bash
   docker run -d --name caddy --restart unless-stopped --network host -v caddy-data:/data caddy:2 \
     caddy reverse-proxy --from party.example.com --to localhost:8096
   ```
3. `docker compose up -d --build`
4. Make the QR code point to `https://party.example.com`.

Built-in limits: 5 wrong admin passwords per IP lock that IP out for 15 minutes, 1 entry per phone (removable by its owner until voting starts), 200 entries in total, uploads must be real JPEGs up to 8 MB.

## How it works

1. **Enrollment** — guests enter a name and take a photo (or pick one from the gallery). Photos are resized on the phone before upload. Everyone sees all entered photos right away. Each phone can enter one photo and remove it again until voting starts.
2. **Voting** — the host presses *Start voting*. Guests see every costume and tap one to vote. One vote per phone, changeable until voting closes, and you can't vote for your own costume.
3. **Closed** — the host presses *Close voting*; the admin page shows the winner (or the tie) and the full leaderboard. Results are only ever visible on the admin page.

Late arrivals can still enrol while voting is open. The host can remove any entry from the admin page.

## Storage

No database server: the app uses SQLite built into Node 24 (`node:sqlite`). The database and photos live in the `party-data` Docker volume. To wipe everything after the party: `docker compose down -v`.
