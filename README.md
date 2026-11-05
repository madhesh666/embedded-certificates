# Embeddedxplore2k26 – Certificate Portal

Embedded Systems & Smart Electronics Club · Dept. of ECE · CKCET

## Admin login (default)

| Field    | Value            |
|----------|------------------|
| Username | `admin`          |
| Password | `Embedded@2k26`  |

**Change the password before going live** – see "Change admin password" below.

## Run it

1. Install Node.js 18+ from https://nodejs.org
2. In this folder:
   ```
   npm install
   npm start
   ```
3. Open:
   - Student page: http://localhost:3000/
   - Admin page:   http://localhost:3000/admin.html

## How it works

**Admin**
1. Go to `/admin.html` and sign in.
2. Enter the event name and certificate type (Participation / Winner / ...).
3. Upload ONE PDF that contains all certificates, one certificate per page.
4. The server reads the name on every page automatically. If a name was not detected,
   open "View / edit names" and type it in.
5. Upload one PDF per event / type (e.g. Participation PDF, Winner PDF).
6. Check the Feedback tab (with CSV export) and the Download log tab.

**Student** (no account needed)
1. Type name, choose department and year, click "Find my certificate".
2. Preview and download the certificate (only their own page is downloaded).
3. Fill the feedback form: rating, what they liked, what to improve.

## Change admin password

```
# Windows (PowerShell)
$env:ADMIN_USER="admin"; $env:ADMIN_PASS="YourNewPassword"; npm start

# Linux / Mac
ADMIN_PASS="YourNewPassword" npm start
```

## Customise

- College logo: put your logo as `public/logo.png` (shows in the header automatically).
- Department / year options: edit the `<select>` lists in `public/index.html`.
- Colours: edit the variables at the top of `public/style.css`.
- Data (certificate index, feedback, uploaded PDFs) is stored in the `data/` folder – back it up.

## Putting it online

Deploy the folder to any Node host (Render, Railway, a college server, etc.).
Set `ADMIN_PASS` as an environment variable and keep the `data/` folder on persistent storage.
Use HTTPS in production.

## Notes

- Certificate PDFs must have selectable text (exported from Canva / PowerPoint / Word).
  Scanned image-only PDFs need names typed manually in the admin page.
- Students need at least 3 letters of their name to search.
