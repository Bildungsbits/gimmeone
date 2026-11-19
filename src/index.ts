import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb, PDFFont } from 'pdf-lib';
import { hashPassword, verifyPassword, sha256hex, randomToken, normalizeName } from './util';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_TTL_STUNDEN?: string;
  ARCHIV_AUFBEWAHRUNG_TAGE?: string;
}

interface Lehrer {
  id: number;
  email: string;
}

type App = Hono<{ Bindings: Env; Variables: { lehrer: Lehrer } }>;

const app: App = new Hono<{ Bindings: Env; Variables: { lehrer: Lehrer } }>();

const COOKIE = 'lehrer_session';
const MAX_EINTRAEGE_PRO_SITZUNG = 100;

// ---------- Helfer ----------

async function getLehrer(c: any): Promise<Lehrer | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(
    `SELECT l.id, l.email FROM lehrer_session s
     JOIN lehrer l ON l.id = s.lehrer_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(await sha256hex(token))
    .first();
  return (row as { id: number; email: string } | null) ?? null;
}

async function createSessionAndCookie(c: any, lehrerId: number): Promise<void> {
  const token = randomToken(32);
  const ttl = Math.max(1, parseInt(c.env.SESSION_TTL_STUNDEN ?? '12', 10) || 12);
  await c.env.DB.prepare(
    `INSERT INTO lehrer_session (token_hash, lehrer_id, expires_at) VALUES (?, ?, datetime('now', ?))`,
  )
    .bind(await sha256hex(token), lehrerId, `+${ttl} hours`)
    .run();
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: ttl * 3600,
    secure: new URL(c.req.url).protocol === 'https:',
  });
}

// Liefert die Sitzung nur, wenn sie der eingeloggten Lehrkraft gehört
async function ownedSitzung(c: any, id: number) {
  const lehrer = c.get('lehrer');
  return c.env.DB.prepare(
    `SELECT s.*, k.name AS klasse_name FROM sitzung s
     JOIN klasse k ON k.id = s.klasse_id
     WHERE s.id = ? AND k.lehrer_id = ?`,
  )
    .bind(id, lehrer.id)
    .first();
}

function parseId(raw: string): number {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) ? id : -1;
}

async function bodyJson(c: any): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// ---------- Noten mit Plus/Minus-Tendenz ----------

// Anzeige-Label, z. B. "2+" oder "2-"
function noteLabel(note: number, tendenz: unknown): string {
  return `${note}${tendenz === '+' || tendenz === '-' ? tendenz : ''}`;
}

// Zahlenwert für den Durchschnitt in Drittelstufen: 1+ = 0,67 ... 5- = 5,33, 6 = 6
function noteWert(note: number, tendenz: unknown): number {
  if (tendenz === '+') return note - 1 / 3;
  if (tendenz === '-') return note + 1 / 3;
  return note;
}

// ---------- Middleware ----------

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  await next();
});

const auth = async (c: any, next: any) => {
  const lehrer = await getLehrer(c);
  if (!lehrer) return c.json({ error: 'Nicht eingeloggt.' }, 401);
  c.set('lehrer', lehrer);
  await next();
};

// ---------- Öffentliche Seiten ----------

// Schüler:innen-Landing nach dem Scannen des QR-Codes
app.get('/s/:token', async (c) => {
  const s = await c.env.DB.prepare('SELECT id FROM sitzung WHERE token = ?').bind(c.req.param('token')).first();
  if (!s) return c.notFound();
  return c.env.ASSETS.fetch(new URL('/beitreten.html', c.req.url));
});

app.get('/admin/login', (c) => c.env.ASSETS.fetch(new URL('/login.html', c.req.url)));

app.get('/impressum', (c) => c.env.ASSETS.fetch(new URL('/impressum.html', c.req.url)));

app.get('/admin', async (c) => {
  const lehrer = await getLehrer(c);
  if (!lehrer) return c.redirect('/admin/login');
  return c.env.ASSETS.fetch(new URL('/dashboard.html', c.req.url));
});

// ---------- Öffentliche API (Schüler:innen) ----------

app.get('/api/s/:token', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT s.fach, s.datum, s.stunde, s.status, s.begruendung_erlaubt, k.name AS klasse_name
     FROM sitzung s JOIN klasse k ON k.id = s.klasse_id WHERE s.token = ?`,
  )
    .bind(c.req.param('token'))
    .first();
  if (!row) return c.json({ error: 'Sitzung nicht gefunden.' }, 404);
  return c.json(row);
});

app.post('/api/s/:token/eintrag', async (c) => {
  const s = await c.env.DB.prepare('SELECT id, status, begruendung_erlaubt FROM sitzung WHERE token = ?')
    .bind(c.req.param('token'))
    .first() as { id: number; status: string; begruendung_erlaubt: number } | null;
  if (!s) return c.json({ error: 'Sitzung nicht gefunden.' }, 404);
  if (s.status !== 'offen') {
    return c.json({ error: 'Diese Sitzung ist bereits geschlossen. Änderungen sind nicht mehr möglich.' }, 409);
  }

  const body = await bodyJson(c);
  const vorname = String(body?.vorname ?? '').trim();
  const initials = String(body?.initials ?? '').trim();
  const note = Number(body?.note);
  const tendenz = String(body?.tendenz ?? '').trim();

  if (!/^[A-Za-zÀ-ÿ'’.\- ]{1,60}$/.test(vorname)) {
    return c.json({ error: 'Bitte einen gültigen Vornamen eingeben.' }, 400);
  }
  if (!/^[A-Za-zÀ-ÿß]{2}$/.test(initials)) {
    return c.json({ error: 'Bitte genau die ersten zwei Buchstaben des Nachnamens eingeben.' }, 400);
  }
  if (!Number.isInteger(note) || note < 1 || note > 6) {
    return c.json({ error: 'Bitte eine Note von 1 bis 6 wählen.' }, 400);
  }
  if (!['+', '-', ''].includes(tendenz)) {
    return c.json({ error: "Die Tendenz muss '+', '-' oder leer sein." }, 400);
  }
  if (note === 6 && tendenz !== '') {
    return c.json({ error: 'Zur Note 6 gibt es keine Plus/Minus-Tendenz.' }, 400);
  }

  // Begründung nur, wenn die Lehrkraft sie für diese Sitzung aktiviert hat (Standard: aus)
  let begruendung: string | null = null;
  if (s.begruendung_erlaubt) {
    begruendung = String(body?.begruendung ?? '').replace(/\s+/g, ' ').trim();
    if (begruendung.length > 300) {
      return c.json({ error: 'Die Begründung darf höchstens 300 Zeichen lang sein.' }, 400);
    }
    if (!begruendung) begruendung = null;
  }

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM eintrag WHERE sitzung_id = ?')
    .bind(s.id)
    .first() as { n: number } | null;
  if (count && count.n >= MAX_EINTRAEGE_PRO_SITZUNG) {
    return c.json({ error: 'Die maximale Anzahl an Einträgen ist erreicht.' }, 429);
  }

  // Gleicher Name in derselben Sitzung = gleicher Hash -> bereits abgegeben, keine Änderung möglich
  const nameHash = await sha256hex(`${s.id}|${normalizeName(vorname)}|${normalizeName(initials)}`);
  const vorhanden = await c.env.DB.prepare('SELECT id FROM eintrag WHERE sitzung_id = ? AND name_hash = ?')
    .bind(s.id, nameHash)
    .first();
  if (vorhanden) {
    return c.json(
      { error: 'Für diesen Namen wurde bereits eine Note abgegeben. Eine Änderung ist nicht mehr möglich.' },
      409,
    );
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO eintrag (sitzung_id, name_hash, vorname, initials, note, tendenz, begruendung)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(s.id, nameHash, vorname, initials.toUpperCase(), note, tendenz, begruendung)
      .run();
  } catch (e: any) {
    // UNIQUE(sitzung_id, name_hash) als Schutz bei parallelen Abgaben
    if (String(e?.message ?? '').includes('UNIQUE')) {
      return c.json(
        { error: 'Für diesen Namen wurde bereits eine Note abgegeben. Eine Änderung ist nicht mehr möglich.' },
        409,
      );
    }
    throw e;
  }

  return c.json({ ok: true, vorname, note, tendenz });
});

// QR-Code: /qr/:token.svg liefert das SVG, /qr/:token die großflächige Ansichtsseite
app.get('/qr/:filename', async (c) => {
  const filename = c.req.param('filename');
  const token = filename.replace(/\.svg$/i, '');
  const s = await c.env.DB.prepare('SELECT id FROM sitzung WHERE token = ?').bind(token).first();
  if (!s) return c.notFound();
  if (/\.svg$/i.test(filename)) {
    const url = new URL(`/s/${token}`, c.req.url).toString();
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 300, errorCorrectionLevel: 'M' });
    return new Response(svg, {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
    });
  }
  return c.env.ASSETS.fetch(new URL('/qr.html', c.req.url));
});

// ---------- Lehrer-Auth ----------

app.post('/api/lehrer/registrieren', async (c) => {
  const body = await bodyJson(c);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const passwort = String(body?.passwort ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return c.json({ error: 'Bitte eine gültige E-Mail-Adresse eingeben.' }, 400);
  }
  if (passwort.length < 8) {
    return c.json({ error: 'Das Passwort muss mindestens 8 Zeichen lang sein.' }, 400);
  }
  const hash = await hashPassword(passwort);
  let lehrerId: number;
  try {
    const res = await c.env.DB.prepare('INSERT INTO lehrer (email, passwort_hash) VALUES (?, ?)')
      .bind(email, hash)
      .run();
    lehrerId = Number(res.meta.last_row_id);
  } catch (e: any) {
    if (String(e?.message ?? '').includes('UNIQUE')) {
      return c.json({ error: 'Diese E-Mail-Adresse ist bereits registriert. Bitte anmelden.' }, 409);
    }
    throw e;
  }
  await createSessionAndCookie(c, lehrerId);
  return c.json({ ok: true, email }, 201);
});

app.post('/api/lehrer/login', async (c) => {
  const body = await bodyJson(c);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const passwort = String(body?.passwort ?? '');
  const row = (await c.env.DB.prepare('SELECT id, passwort_hash FROM lehrer WHERE email = ?').bind(email).first()) as {
    id: number;
    passwort_hash: string;
  } | null;
  if (!row || !(await verifyPassword(passwort, row.passwort_hash))) {
    return c.json({ error: 'E-Mail oder Passwort falsch.' }, 401);
  }
  await createSessionAndCookie(c, row.id);
  return c.json({ ok: true, email });
});

app.post('/api/lehrer/logout', async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM lehrer_session WHERE token_hash = ?').bind(await sha256hex(token)).run();
  }
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', auth, (c) => c.json({ email: c.get('lehrer').email }));

// ---------- Geschützte Lehrer-API ----------

app.use('/api/klassen/*', auth);
app.use('/api/sitzungen/*', auth);

app.get('/api/klassen', async (c) => {
  const lehrer = c.get('lehrer');
  const { results } = await c.env.DB.prepare(
    `SELECT k.id, k.name, k.erstellt_am,
            (SELECT COUNT(*) FROM sitzung s WHERE s.klasse_id = k.id) AS sitzungsanzahl,
            (SELECT COUNT(*) FROM sitzung s WHERE s.klasse_id = k.id AND s.status = 'offen') AS offene
     FROM klasse k WHERE k.lehrer_id = ? ORDER BY k.name COLLATE NOCASE`,
  )
    .bind(lehrer.id)
    .all();
  return c.json({ klassen: results });
});

app.post('/api/klassen', async (c) => {
  const lehrer = c.get('lehrer');
  const body = await bodyJson(c);
  const name = String(body?.name ?? '').trim();
  if (!name || name.length > 80) return c.json({ error: 'Bitte einen Klassennamen eingeben (max. 80 Zeichen).' }, 400);
  const res = await c.env.DB.prepare('INSERT INTO klasse (lehrer_id, name) VALUES (?, ?)')
    .bind(lehrer.id, name)
    .run();
  return c.json({ ok: true, id: Number(res.meta.last_row_id), name }, 201);
});

app.get('/api/klassen/:id', async (c) => {
  const lehrer = c.get('lehrer');
  const id = parseId(c.req.param('id'));
  const klasse = await c.env.DB.prepare('SELECT * FROM klasse WHERE id = ? AND lehrer_id = ?')
    .bind(id, lehrer.id)
    .first();
  if (!klasse) return c.json({ error: 'Klasse nicht gefunden.' }, 404);
  const { results: sitzungen } = await c.env.DB.prepare(
    `SELECT s.id, s.fach, s.datum, s.stunde, s.token, s.status, s.begruendung_erlaubt, s.archiviert_am, s.erstellt_am,
            (SELECT COUNT(*) FROM eintrag e WHERE e.sitzung_id = s.id) AS anzahl
     FROM sitzung s WHERE s.klasse_id = ? ORDER BY s.erstellt_am DESC`,
  )
    .bind(id)
    .all();
  return c.json({ klasse, sitzungen });
});

app.delete('/api/klassen/:id', async (c) => {
  const lehrer = c.get('lehrer');
  const id = parseId(c.req.param('id'));
  const res = await c.env.DB.prepare('DELETE FROM klasse WHERE id = ? AND lehrer_id = ?').bind(id, lehrer.id).run();
  if (!res.meta.changes) return c.json({ error: 'Klasse nicht gefunden.' }, 404);
  return c.json({ ok: true });
});

app.post('/api/klassen/:id/sitzungen', async (c) => {
  const lehrer = c.get('lehrer');
  const klasseId = parseId(c.req.param('id'));
  const klasse = await c.env.DB.prepare('SELECT id FROM klasse WHERE id = ? AND lehrer_id = ?')
    .bind(klasseId, lehrer.id)
    .first();
  if (!klasse) return c.json({ error: 'Klasse nicht gefunden.' }, 404);

  const body = await bodyJson(c);
  const fach = String(body?.fach ?? '').trim();
  const datum = String(body?.datum ?? '').trim();
  const stunde = String(body?.stunde ?? '').trim().slice(0, 40) || null;
  const begruendungErlaubt = body?.begruendung_erlaubt === true ? 1 : 0;
  if (!fach || fach.length > 80) return c.json({ error: 'Bitte ein Fach eingeben (max. 80 Zeichen).' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
    return c.json({ error: 'Bitte ein gültiges Datum eingeben (JJJJ-MM-TT).' }, 400);
  }
  const token = randomToken(16);
  const res = await c.env.DB.prepare(
    'INSERT INTO sitzung (klasse_id, fach, datum, stunde, token, status, begruendung_erlaubt) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(klasseId, fach, datum, stunde, token, 'offen', begruendungErlaubt)
    .run();
  return c.json({ ok: true, id: Number(res.meta.last_row_id), token }, 201);
});

// Übersicht einer Sitzung inkl. aller Einträge (nur für Eigentümer)
app.get('/api/sitzungen/:id', async (c) => {
  const s = await ownedSitzung(c, parseId(c.req.param('id')));
  if (!s) return c.json({ error: 'Sitzung nicht gefunden.' }, 404);
  const { results: eintraege } = await c.env.DB.prepare(
    `SELECT vorname, initials, note, tendenz, begruendung, erstellt_am, geaendert_am FROM eintrag
     WHERE sitzung_id = ? ORDER BY vorname COLLATE NOCASE, initials`,
  )
    .bind(s.id)
    .all();
  return c.json({ sitzung: s, eintraege });
});

app.post('/api/sitzungen/:id/schliessen', async (c) => {
  const s = await ownedSitzung(c, parseId(c.req.param('id')));
  if (!s) return c.json({ error: 'Sitzung nicht gefunden.' }, 404);
  if (s.status === 'archiviert') return c.json({ error: 'Archivierte Sitzungen können nicht geändert werden.' }, 409);
  await c.env.DB.prepare("UPDATE sitzung SET status = 'geschlossen' WHERE id = ?").bind(s.id).run();
  return c.json({ ok: true, status: 'geschlossen' });
});

app.post('/api/sitzungen/:id/archivieren', async (c) => {
  const s = await ownedSitzung(c, parseId(c.req.param('id')));
  if (!s) return c.json({ error: 'Sitzung nicht gefunden.' }, 404);
  if (s.status === 'archiviert') return c.json({ ok: true, status: 'archiviert' });
  await c.env.DB.prepare("UPDATE sitzung SET status = 'archiviert', archiviert_am = datetime('now') WHERE id = ?")
    .bind(s.id)
    .run();
  return c.json({ ok: true, status: 'archiviert' });
});

// ---------- Export ----------

function csvEsc(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// Standard-Fonts (Helvetica) können nur WinAnsi kodieren. Zeichen außerhalb
// (z. B. Emoji in Begründungen oder Klassennamen) würden den Export mit 500
// abbrechen lassen -> sie werden durch '?' ersetzt.
function pdfSafe(text: unknown, f: PDFFont): string {
  let out = '';
  for (const ch of String(text ?? '')) {
    try {
      f.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

// Einfacher Wortumbruch für PDF-Textzeilen
function pdfWrap(text: string, f: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? line + ' ' + w : w;
    if (line && f.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function exportDateiname(s: any): string {
  const base = `noten_${s.klasse_name}_${s.fach}_${s.datum}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '_');
  // (Combining Marks entfernen, damit Umlaute im Dateinamen ASCII-kompatibel werden)
  return base.slice(0, 120);
}

app.get('/api/sitzungen/:id/export.csv', async (c) => {
  const s = await ownedSitzung(c, parseId(c.req.param('id')));
  if (!s) return c.json({ error: 'Sitzung nicht gefunden.' }, 404);
  const { results } = await c.env.DB.prepare(
    'SELECT vorname, initials, note, tendenz, begruendung, erstellt_am, geaendert_am FROM eintrag WHERE sitzung_id = ? ORDER BY vorname COLLATE NOCASE',
  )
    .bind(s.id)
    .all() as unknown as { results: Record<string, unknown>[] };
  const mitBegruendung = Number((s as any).begruendung_erlaubt) === 1;
  const lines = [
    mitBegruendung
      ? 'Vorname;Nachname (2 Buchstaben);Note;Tendenz;Begründung;Erstellt am;Geändert am;'
      : 'Vorname;Nachname (2 Buchstaben);Note;Tendenz;Erstellt am;Geändert am;',
  ];
  for (const e of results) {
    const felder = [csvEsc(e.vorname), csvEsc(e.initials), e.note, csvEsc(e.tendenz)];
    if (mitBegruendung) felder.push(csvEsc(e.begruendung));
    felder.push(csvEsc(e.erstellt_am), csvEsc(e.geaendert_am));
    lines.push(felder.join(';'));
  }
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n'; // BOM für Excel
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportDateiname(s)}.csv"`,
    },
  });
});

app.get('/api/sitzungen/:id/export.pdf', async (c) => {
  const s = await ownedSitzung(c, parseId(c.req.param('id')));
  if (!s) return c.json({ error: 'Sitzung nicht gefunden.' }, 404);
  const { results } = await c.env.DB.prepare(
    'SELECT vorname, initials, note, tendenz, begruendung, erstellt_am FROM eintrag WHERE sitzung_id = ? ORDER BY vorname COLLATE NOCASE',
  )
    .bind(s.id)
    .all() as unknown as {
    results: { vorname: string; initials: string; note: number; tendenz: string; begruendung: string | null; erstellt_am: string }[];
  };

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 10;
  const A4: [number, number] = [595.28, 841.89];
  let page = doc.addPage(A4);
  let y = A4[1] - 50;

  const header = () => {
    page.drawText(pdfSafe(`Notenübersicht: ${s.fach} – ${s.klasse_name}`, bold), { x: 50, y, size: 16, font: bold });
    y -= 18;
    const avg =
      results.length > 0
        ? (results.reduce((a, e) => a + noteWert(e.note, e.tendenz), 0) / results.length).toFixed(2).replace('.', ',')
        : '–';
    page.drawText(
      pdfSafe(
        `Datum: ${s.datum}${s.stunde ? ' · ' + s.stunde : ''} · Status: ${s.status} · Einträge: ${results.length} · Ø Note: ${avg}`,
        font,
      ),
      { x: 50, y, size, font },
    );
    y -= 24;
    const cols: [number, string][] = [
      [50, 'Nr.'],
      [80, 'Vorname'],
      [260, 'Nachname (2 Buchstaben)'],
      [420, 'Note'],
      [470, 'Erfasst am'],
    ];
    for (const [x, t] of cols) page.drawText(t, { x, y, size, font: bold });
    y -= 6;
    page.drawLine({ start: { x: 50, y }, end: { x: A4[0] - 50, y }, thickness: 1, color: rgb(0.7, 0.7, 0.7) });
    y -= 14;
  };
  header();

  results.forEach((e, i) => {
    if (y < 50) {
      page = doc.addPage(A4);
      y = A4[1] - 50;
    }
    const row: [number, string][] = [
      [50, String(i + 1)],
      [80, pdfSafe(e.vorname, font)],
      [260, pdfSafe(e.initials, font)],
      [420, noteLabel(e.note, e.tendenz)],
      [470, String(e.erstellt_am).replace('T', ' ').slice(0, 16)],
    ];
    for (const [x, t] of row) page.drawText(t, { x, y, size, font });
    y -= 16;
    if (e.begruendung) {
      for (const ln of pdfWrap(pdfSafe(e.begruendung, font), font, 8, A4[0] - 130)) {
        if (y < 40) {
          page = doc.addPage(A4);
          y = A4[1] - 50;
        }
        page.drawText('– ' + ln, { x: 80, y, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
        y -= 11;
      }
    }
  });

  const pdfBytes = await doc.save();
  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${exportDateiname(s)}.pdf"`,
    },
  });
});

// ---------- Fehlerbehandlung ----------

app.notFound((c) => c.json({ error: 'Nicht gefunden.' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Interner Fehler.' }, 500);
});

export default {
  fetch: app.fetch,
  // Täglicher Cron: archivierte Sitzungen nach Aufbewahrungsfrist löschen (Kaskade löscht Einträge)
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const tage = Math.max(1, parseInt(env.ARCHIV_AUFBEWAHRUNG_TAGE ?? '365', 10) || 365);
    await env.DB.prepare(
      `DELETE FROM sitzung WHERE status = 'archiviert' AND archiviert_am < datetime('now', ?)`,
    )
      .bind(`-${tage} days`)
      .run();
  },
};
