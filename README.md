

# Embeddedxplore2k26 – Certificate Portal

Embedded Systems & Smart Electronics Club · Dept. of ECE · CKCET

## Admin login (default)

| Field | Value |
|---|---|
| Username | `admin` |
| Password | `Embedded@2k26` |

**Change the password before going live.**

## Run it

1. Install Node.js 18+ from https://nodejs.org
2. Open CMD in the project folder and run:

```bash
npm install
npm start
```

3. Open:
   - Student page: http://localhost:3000/
   - Admin page: http://localhost:3000/admin.html

## How it works

### Admin
1. Go to `/admin.html` and sign in.
2. Enter the event name and certificate type.
3. Upload one PDF containing all certificates.
4. Verify detected names and correct them if necessary.
5. Upload separate PDFs for each event/type.
6. Check feedback and download logs.

### Student
1. Enter name, department and year.
2. Click Find my certificate.
3. Preview and download the certificate.
4. Submit feedback.

## Change admin password

Set `ADMIN_PASS` as an environment variable before starting the server.

## Customise

- College logo: `public/logo.png`
- Department/year: `public/index.html`
- Colours: `public/style.css`
- Data: `data/` folder

## Putting it online

Deploy to a Node.js hosting platform. Use HTTPS and persistent storage for the `data/` folder.
