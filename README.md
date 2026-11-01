# Smart Gate Keeper

A software-only, web-based QR code campus access and visitor management system. Students and visitors generate a short-lived QR pass, security scans it at the gate, and admins watch live entry and exit logs.

- **Frontend:** React + TypeScript (Vite), Tailwind CSS, `qrcode.react`, `html5-qrcode`, Lucide icons
- **Backend:** FastAPI (Python), SQLAlchemy, SQLite

## Features

- **Student Pass:** enter name, roll number / USN, department and pass type (Student Daily or Visitor Pre-Approved). The app renders a QR pass with a 15-minute countdown.
- **Security Gate Scanner:** webcam scanning, manual USN fallback and a scan simulator. Shows a green "ACCESS GRANTED" or red "ACCESS DENIED" popup.
- **Admin Live Log:** live KPIs (people on campus, check-ins and check-outs today, failed scans) and a searchable table of every scan.

### How passes are secured

- The QR encodes `{ usn, timestamp, pass_id, secret_token }`.
- `secret_token` is an HMAC-SHA256 signature created on the server, so a QR can't be forged or edited.
- A pass expires 15 minutes after it is issued.
- Generating a new pass for the same person invalidates their older QR.
- Each granted scan alternates between check-in and check-out.

## Project structure

```
smart-gate-keeper/
├── backend/
│   ├── main.py            FastAPI app and endpoints
│   ├── models.py          SQLAlchemy models (User, GateAccessLog)
│   └── requirements.txt
└── frontend/
    └── src/App.tsx        Single-file React app
```

## Getting started (Windows PowerShell)

Prerequisites: Python 3.11+, Node.js LTS, Git.

### 1. Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

On macOS or Linux, activate the environment with `source .venv/bin/activate` instead.

Check it works: http://127.0.0.1:8000/api/health should return `{"ok":true}`. The API docs are at http://127.0.0.1:8000/docs.

If PowerShell blocks the activate script, run this once, then try again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### 2. Frontend (in a second terminal)

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The header badge shows **API live** when the backend is connected, or **Demo mode** when it isn't. In demo mode the app runs entirely in the browser using local storage, so you can try everything without the backend.

If the frontend is started from scratch, install the extra packages and enable Tailwind:

```powershell
npm install qrcode.react html5-qrcode lucide-react tailwindcss @tailwindcss/vite
```

- Add `tailwindcss()` from `@tailwindcss/vite` to the `plugins` array in `vite.config.ts`.
- Put `@import "tailwindcss";` in `src/index.css`.

## Trying it out

1. **Student Pass:** fill in the form and click *Generate Dynamic Pass*.
2. **Security Gate Scanner:** click *Scan pass* to simulate a scan, or hold the QR up to the webcam. Scan again to see a check-out.
3. Click *Forged QR* to see a denied scan.
4. **Admin Live Log:** watch the counters and table update every few seconds.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/pass/generate` | Create a pass and signed QR payload |
| POST | `/api/pass/verify` | Verify a QR payload or manual USN, and record the entry |
| GET | `/api/logs?q=&limit=` | Recent access history, optionally filtered by USN or name |
| GET | `/api/stats/campus-count` | People inside, check-ins and check-outs today, failed scans |
| GET | `/api/health` | Health check |

## Configuration

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `SGK_SECRET` | backend | `dev-only-change-me` | Key used to sign passes. **Change this in any real deployment.** |
| `SGK_DATABASE_URL` | backend | `sqlite:///./gatekeeper.db` | Database location |
| `SGK_CORS` | backend | `*` | Comma-separated allowed origins |
| `VITE_API_URL` | frontend | `http://localhost:8000` | Backend address |

## Notes and troubleshooting

- **Camera:** browsers only allow webcam access on `localhost` or HTTPS. Opening the dev server from a phone over the local network won't work without HTTPS.
- **Port 8000 already in use:** an older uvicorn is still running. Close the old terminal, or run `Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`.
- **`Could not import module "main"`:** make sure the file is named exactly `main.py` (downloads sometimes become `main (1).py`).
- **Unstyled page:** check that `@tailwindcss/vite` is in `vite.config.ts`, `src/index.css` has the Tailwind import, and restart `npm run dev`.
- **Reset data:** stop the backend and delete `gatekeeper.db`.

## Limitations (prototype)

- No login: the scanner and admin tabs are open to anyone.
- The admin log refreshes by polling every 3 seconds rather than by WebSocket.
- SQLite is for development; use a server database such as PostgreSQL for production.
