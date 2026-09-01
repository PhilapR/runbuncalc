-- The project ledger: rulings, open questions, and review findings.
--
-- Runs unchanged on Cloudflare D1 and on node:sqlite, so the same schema
-- backs the deployed query surface and the offline one. Nothing here is the
-- system of record — ledger/*.json and DECISIONS.json are, because a record
-- that cannot be read in a diff cannot be reviewed. This is the projection
-- those files are loaded into so they can be asked questions.
--
-- Rebuild is destructive and total: `node scripts/ledger.js build` drops and
-- reloads. That is deliberate. An incremental sync would let the database
-- and the files disagree, and then neither is the record.

DROP TABLE IF EXISTS finding_notes;
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS open_questions;
DROP TABLE IF EXISTS decisions;

-- Standing rulings. Loaded from DECISIONS.json, which stays where it is:
-- README.md, ECOSYSTEM.json and scripts/inventory.js all read it already.
CREATE TABLE decisions (
  id           TEXT PRIMARY KEY,
  decided_on   TEXT NOT NULL,
  ruling       TEXT NOT NULL,
  why          TEXT,
  -- JSON array of paths. Denormalised on purpose: it is read whole, never
  -- joined, and a junction table would make the export diff unreadable.
  enforced_by  TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE open_questions (
  id           TEXT PRIMARY KEY,
  question     TEXT NOT NULL,
  raised_on    TEXT,
  settled_by   TEXT
);

-- Review findings. This table is the reason the ledger exists: four
-- independent reviews produced ~50 findings that lived only in a session
-- transcript and in commit messages, where nothing can query them.
CREATE TABLE findings (
  id           TEXT PRIMARY KEY,
  -- Which review raised it. Reviews are independent by construction: each
  -- reviewer got the spec and the diff, never another reviewer's reasoning.
  source       TEXT NOT NULL,
  raised_on    TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'warning')),
  area         TEXT NOT NULL,
  file         TEXT,
  line         INTEGER,
  claim        TEXT NOT NULL,
  -- How far the claim has been taken, NOT how bad it is. A reviewer's claim
  -- is a lead; 'reported' means nobody has re-derived it here yet.
  verdict      TEXT NOT NULL CHECK (verdict IN ('reported', 'confirmed', 'refuted', 'superseded')),
  status       TEXT NOT NULL CHECK (status IN ('open', 'fixed', 'wontfix', 'duplicate')),
  -- The commit that fixed it, when there is one.
  fixed_in     TEXT,
  -- Whether the guard was made to FAIL against the restored defect. A fix
  -- with falsified = 0 is a fix nobody has proved is load-bearing, which is
  -- the failure mode this project keeps hitting.
  falsified    INTEGER NOT NULL DEFAULT 0 CHECK (falsified IN (0, 1)),
  -- How the claim was reproduced here, in the reviewer's or our own numbers.
  evidence     TEXT
);

CREATE INDEX findings_by_status   ON findings (status, severity);
CREATE INDEX findings_by_area     ON findings (area);
CREATE INDEX findings_by_source   ON findings (source);

-- Free-form follow-ups against a finding, so the claim itself stays as the
-- reviewer stated it and does not get rewritten by whoever touched it last.
CREATE TABLE finding_notes (
  finding_id   TEXT NOT NULL REFERENCES findings(id),
  noted_on     TEXT NOT NULL,
  note         TEXT NOT NULL
);

CREATE INDEX finding_notes_by_finding ON finding_notes (finding_id);
