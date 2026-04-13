CREATE OR REPLACE FUNCTION canonicalize_thought_content()
RETURNS TRIGGER AS $$
BEGIN
    NEW.content := regexp_replace(NEW.content, E'^\uFEFF', '');
    NEW.content := regexp_replace(NEW.content, E'\r\n?', E'\n', 'g');
    NEW.content := regexp_replace(NEW.content, E'\n+$', '') || E'\n';
    NEW.content := normalize(NEW.content, NFC);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_canonicalize_content
    BEFORE INSERT OR UPDATE OF content ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION canonicalize_thought_content();

ALTER TABLE thoughts
    ADD COLUMN content_fingerprint text
    GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED;

CREATE INDEX idx_thoughts_content_fingerprint
    ON thoughts(content_fingerprint);
