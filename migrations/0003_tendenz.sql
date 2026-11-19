-- Plus/Minus-Tendenz zur Note (z. B. "2+" oder "2-"). Standard: '' (keine Tendenz).
-- Konvention: Tendenzen nur bei den Noten 1-5, die Note 6 steht immer ohne Tendenz.
ALTER TABLE eintrag ADD COLUMN tendenz TEXT NOT NULL DEFAULT '' CHECK (tendenz IN ('+', '-', ''));
