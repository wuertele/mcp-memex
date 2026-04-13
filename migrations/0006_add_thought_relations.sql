CREATE TABLE thought_relations (
    source_id bigint NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    target_id bigint NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    relation_type text NOT NULL,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (source_id, target_id, relation_type)
);

CREATE INDEX idx_thought_relations_target
    ON thought_relations (target_id, relation_type);
