ALTER TABLE thoughts
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION update_thoughts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_updated_at_trigger
    BEFORE UPDATE ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION update_thoughts_updated_at();

CREATE INDEX idx_thoughts_updated_at ON thoughts(updated_at);
