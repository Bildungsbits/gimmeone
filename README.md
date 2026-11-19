# Noten-QR

Web-App für Selfassessment nach Unterrichtsstunden: Die Lehrkraft zeigt einen QR-Code,
Schülerinnen und Schüler scannen ihn, geben Vorname + erste 2 Buchstaben des Nachnamens
und eine Note (1–6, optional mit Plus/Minus-Tendenz wie „2+“ oder „2-“; bei der 6 nicht vorgesehen) ein.
Der Durchschnitt wird in Drittelstufen gerechnet (1+ = 0,67 … 5− = 5,33). Die Lehrkraft sieht alle
Noten live, kann die Sitzung schließen, als CSV/PDF exportieren und archivieren.
Optional kann die Lehrkraft pro Sitzung eine kurze Begründung (max. 300 Zeichen) erlauben,
die die Lernenden neben der Note eingeben (Standard: ausgeschaltet).

## Stack

- Cloudflare Worker (TypeScript, [Hono](https://hono.dev)) + Workers Static Assets (`public/`)
- Cloudflare D1 (SQLite) für alle Daten
- QR-Code als SVG serverseitig generiert (`qrcode`), PDF-Export mit `pdf-lib`
- Auth: E-Mail + Passwort (PBKDF2-SHA-256, 120.000 Iterationen), Session-Cookie (HttpOnly, SameSite=Lax)

## Lokale Entwicklung

```bash
npm install
npm run db:migrate:local   # lokale D1 (Miniflare) migrieren
npm run dev                # http://127.0.0.1:8787
```

## Deploy auf Cloudflare

```bash
npx wrangler login
npm run db:create          # legt die D1-Datenbank an, ID kopieren
# database_id in wrangler.toml eintragen
npm run db:migrate:remote  # Schema auf die Remote-Datenbank
npm run deploy             # Worker deployen -> https://noten-qr.<subdomain>.workers.dev
```

## URLs

| URL | Zweck |
|---|---|
| `/` | Landing |
| `/admin/login` | Login/Registrierung Lehrkraft |
| `/admin` | Dashboard (nur eingeloggt) |
| `/s/:token` | Schüler-Seite nach dem Scannen des QR-Codes |
| `/qr/:token.svg` | QR-Code zur Sitzung (SVG) |
| `/qr/:token` | QR-Code großflächig auf eigener Seite (Klick auf den Code im Dashboard) |
| `/api/s/:token` + `POST /api/s/:token/eintrag` | Öffentliche Abgabe (einmalig pro Name, 409 bei erneutem Versuch) |
| `/api/klassen*`, `/api/sitzungen*` | Geschützte Lehrer-API (Übersicht, schließen, archivieren, Export) |

## Datenschutz-Hinweise

- Namen werden zusätzlich als SHA-256-Hash (Sitzung + Name) gespeichert; dadurch ist pro
  Sitzung nur eine Note pro Name möglich — eine Note wird einmal eingetragen und kann danach
  nicht mehr geändert werden (erneutes Scannen mit demselben Namen wird mit 409 abgelehnt).
- Nur die Lehrkraft sieht die Übersicht; Schüler:innen sehen nur ihre eigene Bestätigung.
- Ein Cron-Lauf löscht archivierte Sitzungen nach `ARCHIV_AUFBEWAHRUNG_TAGE` (Default 365) inkl. Einträge.
- Für den produktiven Schuleinsatz: AVV mit Cloudflare prüfen, ggf. EU-Self-Hosting als Alternative.
