CREATE TABLE sync_log (
    seq BIGSERIAL PRIMARY KEY,
    thought_id bigint NOT NULL,
    ob_uuid uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

CREATE INDEX idx_sync_log_unprocessed
    ON sync_log (seq) WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION log_thoughts_changes()
RETURNS TRIGGER AS $$
DECLARE
    src text;
BEGIN
    src := current_setting('app.sync_source', TRUE);
    IF src IS NOT DISTINCT FROM 'daemon' THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO sync_log (thought_id, ob_uuid, operation)
        VALUES (NEW.id, NEW.ob_uuid, 'INSERT');
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO sync_log (thought_id, ob_uuid, operation)
        VALUES (NEW.id, NEW.ob_uuid, 'UPDATE');
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO sync_log (thought_id, ob_uuid, operation)
        VALUES (OLD.id, OLD.ob_uuid, 'DELETE');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION log_thoughts_changes();
