use rusqlite::{params, Connection};

use super::{has_branch_call_edges, has_branch_call_edges_stale, DbError, DbResult};

/// Rows one branch catalog holds in each per-branch membership table.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BranchCatalogRows {
    pub branch: String,
    pub branch_chunks: usize,
    pub branch_symbols: usize,
    pub branch_call_edges: usize,
    pub branch_call_edges_stale: usize,
}

/// Rows a catalog prune removed, per branch, plus the metadata keys it deleted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BranchCatalogPrune {
    pub branches: Vec<BranchCatalogRows>,
    pub metadata: usize,
}

struct BranchTables {
    call_edges: bool,
    call_edges_stale: bool,
}

fn branch_tables(conn: &Connection) -> DbResult<BranchTables> {
    Ok(BranchTables {
        call_edges: has_branch_call_edges(conn)?,
        call_edges_stale: has_branch_call_edges_stale(conn)?,
    })
}

fn count_rows(conn: &Connection, table: &str, branch: &str) -> DbResult<usize> {
    let count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE branch = ?1"),
        params![branch],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

fn distinct_branches(conn: &Connection, table: &str, out: &mut Vec<String>) -> DbResult<()> {
    // Skip-scan the (branch, ...) primary key: one seek per catalog, not one per row.
    let mut stmt = conn.prepare(&format!(
        "WITH RECURSIVE keys(branch) AS (
            SELECT MIN(branch) FROM {table}
            UNION ALL
            SELECT (SELECT MIN(branch) FROM {table} WHERE branch > keys.branch)
            FROM keys WHERE keys.branch IS NOT NULL
        )
        SELECT branch FROM keys WHERE branch IS NOT NULL"
    ))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        out.push(row?);
    }
    Ok(())
}

/// Catalog keys that hold call-edge overlay rows, which the chunk and symbol
/// catalog listing does not see.
pub fn get_call_edge_overlay_branches(conn: &Connection) -> DbResult<Vec<String>> {
    let tables = branch_tables(conn)?;
    let mut branches = Vec::new();
    if tables.call_edges {
        distinct_branches(conn, "branch_call_edges", &mut branches)?;
    }
    if tables.call_edges_stale {
        distinct_branches(conn, "branch_call_edges_stale", &mut branches)?;
    }
    branches.sort();
    branches.dedup();
    Ok(branches)
}

/// Count each catalog's rows without changing the store. Overlay tables an
/// older store lacks count as zero.
pub fn count_branch_catalog_rows(
    conn: &Connection,
    branches: &[String],
) -> DbResult<Vec<BranchCatalogRows>> {
    let tables = branch_tables(conn)?;
    branches
        .iter()
        .map(|branch| {
            Ok(BranchCatalogRows {
                branch: branch.clone(),
                branch_chunks: count_rows(conn, "branch_chunks", branch)?,
                branch_symbols: count_rows(conn, "branch_symbols", branch)?,
                branch_call_edges: if tables.call_edges {
                    count_rows(conn, "branch_call_edges", branch)?
                } else {
                    0
                },
                branch_call_edges_stale: if tables.call_edges_stale {
                    count_rows(conn, "branch_call_edges_stale", branch)?
                } else {
                    0
                },
            })
        })
        .collect()
}

/// Delete whole branch catalogs and their metadata keys inside the caller's
/// write transaction, so the caller can verify the catalogs are still unused
/// before it commits. Shared chunks, symbols and edges stay for the orphan GCs.
pub fn delete_branch_catalogs(
    conn: &Connection,
    branches: &[String],
    metadata_keys: &[String],
) -> DbResult<BranchCatalogPrune> {
    if conn.is_autocommit() {
        return Err(DbError::TransactionState(String::from(
            "Deleting branch catalogs requires an active write transaction",
        )));
    }
    let tables = branch_tables(conn)?;
    let mut result = BranchCatalogPrune::default();
    {
        let mut chunks = conn.prepare("DELETE FROM branch_chunks WHERE branch = ?1")?;
        let mut symbols = conn.prepare("DELETE FROM branch_symbols WHERE branch = ?1")?;
        let mut edges = if tables.call_edges {
            Some(conn.prepare("DELETE FROM branch_call_edges WHERE branch = ?1")?)
        } else {
            None
        };
        let mut stale = if tables.call_edges_stale {
            Some(conn.prepare("DELETE FROM branch_call_edges_stale WHERE branch = ?1")?)
        } else {
            None
        };
        let mut metadata = conn.prepare("DELETE FROM metadata WHERE key = ?1")?;

        for branch in branches {
            // Overlay rows go before the branch's symbols, so the member-deleted
            // trigger finds none of them to queue for the orphan GCs.
            let branch_call_edges = match edges.as_mut() {
                Some(statement) => statement.execute(params![branch])?,
                None => 0,
            };
            let branch_call_edges_stale = match stale.as_mut() {
                Some(statement) => statement.execute(params![branch])?,
                None => 0,
            };
            result.branches.push(BranchCatalogRows {
                branch: branch.clone(),
                branch_chunks: chunks.execute(params![branch])?,
                branch_symbols: symbols.execute(params![branch])?,
                branch_call_edges,
                branch_call_edges_stale,
            });
        }
        for key in metadata_keys {
            result.metadata += metadata.execute(params![key])?;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn seed(conn: &Connection, branch: &str, overlay: bool) {
        conn.execute(
            "INSERT INTO branch_chunks (branch, chunk_id) VALUES (?1, 'c1'), (?1, 'c2')",
            params![branch],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO branch_symbols (branch, symbol_id) VALUES (?1, 's1')",
            params![branch],
        )
        .unwrap();
        if overlay {
            conn.execute(
                "INSERT INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved) VALUES (?1, 'e1', NULL, 0)",
                params![branch],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO branch_call_edges_stale (branch, edge_id) VALUES (?1, 'e1')",
                params![branch],
            )
            .unwrap();
        }
    }

    /// Reduce a current store to the marker-1 overlay: the target table
    /// alone, without the stale table, the queue, or any trigger. Dropping a
    /// table that a remaining trigger names would leave a store no opener
    /// produces, where deletes fail with "no such table".
    fn downgrade_overlay_to_marker_1(conn: &Connection) {
        conn.execute_batch(
            "DROP TRIGGER branch_call_edges_legacy_write; \
             DROP TRIGGER branch_call_edges_edge_deleted; \
             DROP TRIGGER branch_call_edges_member_deleted; \
             DROP TABLE branch_call_edges_pending_gc; \
             DROP TABLE branch_call_edges_stale;",
        )
        .unwrap();
    }

    fn pending_gc_rows(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM branch_call_edges_pending_gc",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn deleting_a_catalog_queues_none_of_its_overlay_rows() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(&dir.path().join("queue.db")).unwrap();
        seed(&conn, "gone", true);
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO call_edges (id, from_symbol_id, target_name, to_symbol_id, call_type, line, col, is_resolved)
             VALUES ('e1', 's1', 'callee', NULL, 'Call', 1, 1, 0);",
        )
        .unwrap();

        let pruned = delete_in_tx(&conn, &strings(&["gone"]), &[]).unwrap();
        assert_eq!(pruned.branches, vec![rows("gone", 2, 1, 1, 1)]);
        assert_eq!(pending_gc_rows(&conn), 0);
    }

    fn delete_in_tx(
        conn: &Connection,
        branches: &[String],
        keys: &[String],
    ) -> DbResult<BranchCatalogPrune> {
        conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let result = delete_branch_catalogs(conn, branches, keys);
        conn.execute_batch(if result.is_ok() {
            "COMMIT;"
        } else {
            "ROLLBACK;"
        })
        .unwrap();
        result
    }

    #[test]
    fn refuses_to_delete_outside_a_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(&dir.path().join("autocommit.db")).unwrap();
        seed(&conn, "gone", true);
        assert!(delete_branch_catalogs(&conn, &strings(&["gone"]), &[]).is_err());
        assert_eq!(
            count_branch_catalog_rows(&conn, &strings(&["gone"])).unwrap(),
            vec![rows("gone", 2, 1, 1, 1)]
        );
    }

    #[test]
    fn rolled_back_deletes_leave_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(&dir.path().join("rollback.db")).unwrap();
        seed(&conn, "gone", true);
        conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        delete_branch_catalogs(&conn, &strings(&["gone"]), &[]).unwrap();
        conn.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(
            count_branch_catalog_rows(&conn, &strings(&["gone"])).unwrap(),
            vec![rows("gone", 2, 1, 1, 1)]
        );
    }

    fn rows(
        branch: &str,
        chunks: usize,
        symbols: usize,
        edges: usize,
        stale: usize,
    ) -> BranchCatalogRows {
        BranchCatalogRows {
            branch: branch.to_string(),
            branch_chunks: chunks,
            branch_symbols: symbols,
            branch_call_edges: edges,
            branch_call_edges_stale: stale,
        }
    }

    #[test]
    fn deletes_only_named_catalogs_and_their_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(&dir.path().join("prune.db")).unwrap();
        seed(&conn, "gone", true);
        seed(&conn, "kept", true);
        conn.execute(
            "INSERT INTO metadata (key, value) VALUES ('index.branchCommit.gone', 'a'), ('index.branchCommit.kept', 'b')",
            [],
        )
        .unwrap();

        assert_eq!(
            count_branch_catalog_rows(&conn, &strings(&["gone"])).unwrap(),
            vec![rows("gone", 2, 1, 1, 1)]
        );

        let pruned = delete_in_tx(
            &conn,
            &strings(&["gone", "missing"]),
            &strings(&["index.branchCommit.gone", "index.branchCommit.absent"]),
        )
        .unwrap();
        assert_eq!(
            pruned,
            BranchCatalogPrune {
                branches: vec![rows("gone", 2, 1, 1, 1), rows("missing", 0, 0, 0, 0)],
                metadata: 1,
            }
        );
        assert_eq!(
            count_branch_catalog_rows(&conn, &strings(&["gone", "kept"])).unwrap(),
            vec![rows("gone", 0, 0, 0, 0), rows("kept", 2, 1, 1, 1)]
        );
        let kept_commit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM metadata WHERE key = 'index.branchCommit.kept'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept_commit, 1);
    }

    #[test]
    fn tolerates_stores_without_call_edge_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(&dir.path().join("legacy.db")).unwrap();
        seed(&conn, "gone", false);
        downgrade_overlay_to_marker_1(&conn);
        conn.execute_batch("DROP TABLE branch_call_edges;").unwrap();

        assert_eq!(
            count_branch_catalog_rows(&conn, &strings(&["gone"])).unwrap(),
            vec![rows("gone", 2, 1, 0, 0)]
        );
        let pruned = delete_in_tx(&conn, &strings(&["gone"]), &[]).unwrap();
        assert_eq!(pruned.branches, vec![rows("gone", 2, 1, 0, 0)]);
        assert!(get_call_edge_overlay_branches(&conn).unwrap().is_empty());
    }

    #[test]
    fn lists_catalogs_present_only_in_the_call_edge_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(&dir.path().join("overlay.db")).unwrap();
        seed(&conn, "both", true);
        conn.execute_batch(
            "INSERT INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved) VALUES ('edges-only', 'e1', NULL, 0), ('edges-only', 'e2', NULL, 0);
             INSERT INTO branch_call_edges_stale (branch, edge_id) VALUES ('stale-only', 'e1');",
        )
        .unwrap();

        assert_eq!(
            get_call_edge_overlay_branches(&conn).unwrap(),
            strings(&["both", "edges-only", "stale-only"])
        );
    }

    #[test]
    fn tolerates_overlay_without_stale_table() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(&dir.path().join("v2.db")).unwrap();
        seed(&conn, "gone", false);
        conn.execute(
            "INSERT INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved) VALUES ('gone', 'e1', NULL, 0)",
            [],
        )
        .unwrap();
        downgrade_overlay_to_marker_1(&conn);

        let pruned = delete_in_tx(&conn, &strings(&["gone"]), &[]).unwrap();
        assert_eq!(pruned.branches, vec![rows("gone", 2, 1, 1, 0)]);
    }
}
