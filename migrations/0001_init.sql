CREATE TABLE lehrer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  passwort_hash TEXT NOT NULL,
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lehrer_session (
  token_hash TEXT PRIMARY KEY,
  lehrer_id INTEGER NOT NULL REFERENCES lehrer(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE klasse (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lehrer_id INTEGER NOT NULL REFERENCES lehrer(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sitzung (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  klasse_id INTEGER NOT NULL REFERENCES klasse(id) ON DELETE CASCADE,
  fach TEXT NOT NULL,
  datum TEXT NOT NULL,
  stunde TEXT,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'geschlossen', 'archiviert')),
  archiviert_am TEXT,
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE eintrag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sitzung_id INTEGER NOT NULL REFERENCES sitzung(id) ON DELETE CASCADE,
  name_hash TEXT NOT NULL,
  vorname TEXT NOT NULL,
  initials TEXT NOT NULL,
  note INTEGER NOT NULL CHECK (note BETWEEN 1 AND 6),
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
  geaendert_am TEXT,
  UNIQUE (sitzung_id, name_hash)
);

CREATE INDEX idx_eintrag_sitzung ON eintrag(sitzung_id);
CREATE INDEX idx_sitzung_klasse ON sitzung(klasse_id);
CREATE INDEX idx_sitzung_token ON sitzung(token);
CREATE INDEX idx_klasse_lehrer ON klasse(lehrer_id);
