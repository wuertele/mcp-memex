-- Role for the memex MCP server: can query and write, cannot delete
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memex_mcp') THEN
        CREATE ROLE memex_mcp LOGIN PASSWORD 'memex_mcp_test_password';
    END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE ON thoughts TO memex_mcp;
GRANT SELECT ON sync_log, sync_state TO memex_mcp;
GRANT USAGE, SELECT ON SEQUENCE thoughts_id_seq TO memex_mcp;
GRANT EXECUTE ON FUNCTION match_thoughts TO memex_mcp;
-- Deliberately NOT granted: DELETE on any table

-- Role for the sync daemon: full control
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memex_sync') THEN
        CREATE ROLE memex_sync LOGIN PASSWORD 'memex_sync_test_password';
    END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO memex_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO memex_sync;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO memex_sync;
