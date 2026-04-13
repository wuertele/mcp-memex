ALTER TABLE thoughts
    ADD COLUMN source text
    GENERATED ALWAYS AS (metadata->>'source') STORED;

CREATE INDEX idx_thoughts_source ON thoughts(source);
