# 🎃 Halloween Costume Contest

Mobile web app for a one-night costume contest. Guests snap a photo of their costume from their phone, the host opens voting, everyone votes for their favourite, and the host reveals the winner.

## Run

```bash
docker compose up -d --build
```

- Guests: `http://<your-laptop-LAN-IP>:8080` (find it with `ipconfig getifaddr en0`; turn it into a QR code for the door)
- Host: `http://<your-laptop-LAN-IP>:8080/admin`, password `Haloween2026`

## How it works

1. **Enrollment** — guests enter a name and take a photo (or pick one from the gallery). Photos are resized on the phone before upload.
2. **Voting** — the host presses *Start voting*. Guests see every costume and tap one to vote. One vote per phone, changeable until voting closes, and you can't vote for your own costume.
3. **Closed** — the host presses *Close voting*; the admin page shows the winner (or the tie) and the full leaderboard. Results are only ever visible on the admin page.

Late arrivals can still enrol while voting is open. The host can remove any entry from the admin page.

## Storage

No database server: the app uses SQLite built into Node 24 (`node:sqlite`). The database and photos live in the `party-data` Docker volume. To wipe everything after the party: `docker compose down -v`.
