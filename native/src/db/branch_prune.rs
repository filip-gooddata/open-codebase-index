use rusqlite::{params, Connection};

use super::{has_branch_call_edges, has_branch_call_edges_stale, DbResult};

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

/// Delete whole branch catalogs and their metadata keys in one transaction.
/// Shared chunks, symbols and edges stay for the orphan GCs to judge.
pub fn delete_branch_catalogs(
    conn: &mut Connection,
    branches: &[String],
    metadata_keys: &[String],
) -> DbResult<BranchCatalogPrune> {
    let tx = conn.transaction()?;
    let tables = branch_tables(&tx)?;
    let mut result = BranchCatalogPrune::default();
    {
        let mut chunks = tx.prepare("DELETE FROM branch_chunks WHERE branch = ?1")?;
        let mut symbols = tx.prepare("DELETE FROM branch_symbols WHERE branch = ?1")?;
        let mut edges = if tables.call_edges {
            Some(tx.prepare("DELETE FROM branch_call_edges WHERE branch = ?1")?)
        } else {
            None
        };
        let mut stale = if tables.call_edges_stale {
            Some(tx.prepare("DELETE FROM branch_call_edges_stale WHERE branch = ?1")?)
        } else {
            None
        };
        let mut metadata = tx.prepare("DELETE FROM metadata WHERE key = ?1")?;

        for branch in branches {
            result.branches.push(BranchCatalogRows {
                branch: branch.clone(),
                branch_chunks: chunks.execute(params![branch])?,
                branch_symbols: symbols.execute(params![branch])?,
                branch_call_edges: match edges.as_mut() {
                    Some(statement) => statement.execute(params![branch])?,
                    None => 0,
                },
                branch_call_edges_stale: match stale.as_mut() {
                    Some(statement) => statement.execute(params![branch])?,
                    None => 0,
                },
            });
        }
        for key in metadata_keys {
            result.metadata += metadata.execute(params![key])?;
        }
    }
    tx.commit()?;
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

    fn rows(branch: &str, chunks: usize, symbols: usize, edges: usize, stale: usize) -> BranchCatalogRows {
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
        let mut conn = init_db(&dir.path().join("prune.db")).unwrap();
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

        let pruned = delete_branch_catalogs(
            &mut conn,
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
        let mut conn = init_db(&dir.path().join("legacy.db")).unwrap();
        seed(&conn, "gone", false);
        conn.execute_batch("DROP TABLE branch_call_edges_stale; DROP TABLE branch_call_edges;")
            .unwrap();

        assert_eq!(
            count_branch_catalog_rows(&conn, &strings(&["gone"])).unwrap(),
            vec![rows("gone", 2, 1, 0, 0)]
        );
        let pruned = delete_branch_catalogs(&mut conn, &strings(&["gone"]), &[]).unwrap();
        assert_eq!(pruned.branches, vec![rows("gone", 2, 1, 0, 0)]);
    }

    #[test]
    fn tolerates_overlay_without_stale_table() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = init_db(&dir.path().join("v2.db")).unwrap();
        seed(&conn, "gone", false);
        conn.execute(
            "INSERT INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved) VALUES ('gone', 'e1', NULL, 0)",
            [],
        )
        .unwrap();
        conn.execute_batch("DROP TABLE branch_call_edges_stale;").unwrap();

        let pruned = delete_branch_catalogs(&mut conn, &strings(&["gone"]), &[]).unwrap();
        assert_eq!(pruned.branches, vec![rows("gone", 2, 1, 1, 0)]);
    }
}
