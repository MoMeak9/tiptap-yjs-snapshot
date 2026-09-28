-- Public V2-only reference schema. Apply with your migration tool.
CREATE TABLE IF NOT EXISTS v2_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT,
  content_hash VARCHAR(64) NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision_count BIGINT NOT NULL DEFAULT 0,
  state BYTEA,
  mtime TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_modified_by TEXT,
  deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS v2_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES v2_documents(id),
  version INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('auto', 'open_api', 'manual', 'pre_restore', 'restore')),
  name TEXT,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  schema_version INTEGER NOT NULL,
  source_format TEXT NOT NULL DEFAULT 'v2_json' CHECK (source_format = 'v2_json'),
  state BYTEA NOT NULL CHECK (octet_length(state) > 0),
  created_by TEXT,
  contributors JSONB NOT NULL DEFAULT '[]'::jsonb,
  attribution JSONB,
  ctime TIMESTAMPTZ NOT NULL,
  mtime TIMESTAMPTZ NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  restored_from_revision_id TEXT,
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS v2_revisions_list_idx
  ON v2_revisions (document_id, version DESC, id DESC)
  WHERE deleted = FALSE;
