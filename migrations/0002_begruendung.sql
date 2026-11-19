-- Optionale kurze Begründung pro Eintrag.
-- Die Lehrkraft aktiviert sie pro Sitzung (Standard: aus -> 0).
ALTER TABLE sitzung ADD COLUMN begruendung_erlaubt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eintrag ADD COLUMN begruendung TEXT;
