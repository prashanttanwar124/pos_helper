# NFC Helper Desktop Service

Small local Node.js service for a POS machine with an ACR122U USB NFC reader/writer attached.

It listens only on `127.0.0.1`, so the API is available only to apps running on the same PC.

## What It Does

- `GET /health`
- `POST /nfc/read`
- `POST /nfc/write-url`
- `POST /nfc/lock`
- `POST /attendance/read-card`

Current scope:

- detects whether the reader is connected
- waits for a tag to be tapped
- reads NTAG215 tag content
- writes a URL NDEF record to NTAG215
- locks the tag read-only
- returns POS-friendly success or failure JSON
- keeps a short in-memory recent action log

## Host And Port

- API host: `127.0.0.1`
- API port: `8090`

Example base URL:

```text
http://127.0.0.1:8090
```

## Requirements

- Node.js 18+ recommended
- ACR122U USB NFC reader
- NTAG215 tags
- PC/SC support available in the OS

Platform notes:

- macOS: PC/SC support is built in
- Windows: install the ACR122U driver if needed

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Desktop Controller App

A small cross-platform Electron controller app is included in `desktop/`.

What it does:

- starts the NFC helper
- stops the NFC helper
- shows reader and helper status
- shows recent actions and the last error
- opens the helper log location
- stays available in the menu bar on macOS or the system tray on Windows
- keeps running when the control window is closed

The desktop controller stores its logs and runtime files under Electron's per-user app data folder:

- macOS: `~/Library/Application Support/NFC Helper Control/helper-runtime/`
- Windows: `%APPDATA%\\NFC Helper Control\\helper-runtime\\`

Development run:

```bash
npm install
npm run desktop:dev
```

Package builds:

```bash
npm run desktop:build
```

Window close behavior:

- closing the desktop control window quits the app completely

## GitHub Actions Windows Build

This repo now includes a GitHub Actions workflow that builds a Windows `x64` installer on GitHub's Windows runner.

How to use it:

1. Push your latest changes to GitHub
2. Open the repository on GitHub
3. Go to the `Actions` tab
4. Open `Build Windows Installer`
5. Click `Run workflow`
6. After it finishes, open the workflow run and download the `nfc-helper-control-windows-x64` artifact

That artifact includes the generated Windows installer `.exe`.

What the packaged app includes:

- a bundled Node runtime for the helper
- the helper source and dependencies as packaged app resources

That means the installed desktop app does not need a separate Node.js installation on the target PC.

Packaging targets configured now:

- macOS: `dmg`
- Windows: `nsis`

Important note:

- because `nfc-pcsc` uses native modules, you should build macOS packages on macOS and Windows packages on Windows

## Build A Mac App

You can package the helper as a double-clickable macOS app that includes its own Node runtime.

Build the app bundle:

```bash
./scripts/build-macos-app.sh
```

This creates:

```text
dist/NFC Helper.app
dist/Stop NFC Helper.app
```

Install it into `/Applications`:

```bash
./scripts/install-macos-app.sh
```

What the app does:

- starts the helper in the background
- writes logs to `~/Library/Application Support/NFC Helper/logs/helper.log` for this macOS-only app bundle flow
- shows a confirmation dialog when the helper starts or is already running

The stop app:

- `Stop NFC Helper.app` stops the background helper using its saved PID file
- shows a confirmation dialog after the helper stops

Notes:

- the built app bundles the current local Node runtime from the machine used to build it
- if you share the app with another Mac, build it on the same CPU family as the target machine
- an unsigned app may show a Gatekeeper warning on first launch

## API

### `GET /health`

Returns whether the helper is running and whether a reader is connected.

Example response:

```json
{
  "success": true,
  "running": true,
  "host": "127.0.0.1",
  "port": 8090,
  "reader_connected": true,
  "reader_name": "ACS ACR122U PICC Interface 00 00",
  "pending_operation": null,
  "last_seen_uid": "04A1B2C3D4E5",
  "last_read_at": "2026-04-04T09:02:00.000Z",
  "last_error": null,
  "recent_actions": []
}
```

### `POST /nfc/write-url`

Waits for a tag, verifies that it looks like an NTAG215, then writes a URL NDEF record.

Request:

```json
{
  "token": "tag_7K2P9Q4L8X3M",
  "url": "https://maniratnjewellers.com/verify/tag_7K2P9Q4L8X3M"
}
```

Success response:

```json
{
  "success": true,
  "nfc_uid": "04A1B2C3D4E5",
  "token": "tag_7K2P9Q4L8X3M",
  "url": "https://maniratnjewellers.com/verify/tag_7K2P9Q4L8X3M",
  "message": "Tag written and verified successfully"
}
```

### `POST /nfc/lock`

Waits for a tag and locks it read-only. If the same token was just written in this process, the helper expects the same tag UID for safety.

Request:

```json
{
  "token": "tag_7K2P9Q4L8X3M"
}
```

Success response:

```json
{
  "success": true,
  "nfc_uid": "04A1B2C3D4E5",
  "token": "tag_7K2P9Q4L8X3M",
  "message": "Tag locked successfully"
}
```

### `POST /nfc/read`

Waits for a tag and reads back its current NDEF content.

Success response:

```json
{
  "success": true,
  "nfc_uid": "04A1B2C3D4E5",
  "content": "https://maniratnjewellers.com/verify/tag_7K2P9Q4L8X3M",
  "content_type": "url",
  "message": "Tag read successfully"
}
```

If the tag is empty:

```json
{
  "success": true,
  "nfc_uid": "04A1B2C3D4E5",
  "content": null,
  "content_type": null,
  "message": "Tag is empty"
}
```

### `POST /attendance/read-card`

Simple UID read endpoint for future attendance use.

Success response:

```json
{
  "success": true,
  "nfc_uid": "04A1B2C3D4E5",
  "message": "Card UID read successfully"
}
```

## Example POS Calls

Write tag:

```js
await fetch('http://127.0.0.1:8090/nfc/write-url', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: 'tag_7K2P9Q4L8X3M',
    url: 'https://maniratnjewellers.com/verify/tag_7K2P9Q4L8X3M',
  }),
});
```

Lock tag:

```js
await fetch('http://127.0.0.1:8090/nfc/lock', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: 'tag_7K2P9Q4L8X3M',
  }),
});
```

Read tag:

```js
await fetch('http://127.0.0.1:8090/nfc/read', {
  method: 'POST',
});
```

## Error Behavior

The helper returns human-friendly JSON errors such as:

- `No reader found. Connect the ACR122U reader and try again.`
- `No tag detected before timeout.`
- `Unsupported tag type. Only NTAG215 is supported.`
- `Tag is already locked.`
- `Another NFC operation is already running: write-url`

## Important Notes

- The helper only binds to `127.0.0.1`
- Only one NFC operation runs at a time
- Tag wait timeout is 20 seconds
- Only NTAG215 is supported in this first version
- The lock flow is intended for NTAG215 read-only product tags

## Auto-Start On Boot

### PM2

Install PM2:

```bash
npm install -g pm2
```

Start the helper:

```bash
pm2 start index.js --name nfc-helper
```

Save process list:

```bash
pm2 save
```

Enable startup:

```bash
pm2 startup
```

Run the command PM2 prints, then reboot test the machine.

### systemd

Create `/etc/systemd/system/nfc-helper.service`:

```ini
[Unit]
Description=NFC Helper Desktop Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/NFC Helper
ExecStart=/usr/bin/node /path/to/NFC Helper/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable nfc-helper
sudo systemctl start nfc-helper
```

### Windows

Two easy options:

- run it with PM2
- use Task Scheduler to run `node index.js` at startup or user logon

## macOS And Windows Deployment

- macOS: PM2 is the easiest first setup
- Windows POS PC: PM2 or Task Scheduler both work well
- your POS page should call `http://127.0.0.1:8090`
