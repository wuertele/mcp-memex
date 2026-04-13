ALTER TABLE thoughts
    ADD COLUMN ob_uuid uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX idx_thoughts_ob_uuid ON thoughts(ob_uuid);
