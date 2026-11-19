use super::{
    has_branch_call_edges, has_branch_call_edges_pending_gc, has_branch_call_edges_stale, DbResult,
    BRANCH_CALL_EDGES_SWEEP_PENDING_KEY, SQL_BIND_PARAM_BATCH_SIZE,
};
use rusqlite::{params, Connection, OptionalExtension};
use xxhash_rust::xxh3::Xxh3;

// ============================================================================
// Symbol Operations (Call Graph)
// ============================================================================

#[derive(Debug, Clone)]
pub struct SymbolRow {
    pub id: String,
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub language: String,
}

#[derive(Debug, Clone)]
pub struct CallEdgeRow {
    pub id: String,
    pub from_symbol_id: String,
    pub target_name: String,
    pub to_symbol_id: Option<String>,
    pub call_type: String,
    pub confidence: String,
    pub line: u32,
    pub col: u32,
    pub is_resolved: bool,
}

#[derive(Debug, Clone)]
pub struct CallerRow {
    pub id: String,
    pub from_symbol_id: String,
    pub from_symbol_name: String,
    pub from_symbol_file_path: String,
    pub target_name: String,
    pub to_symbol_id: Option<String>,
    pub call_type: String,
    pub confidence: String,
    pub line: u32,
    pub col: u32,
    pub is_resolved: bool,
}

/// Insert or update a symbol without deleting its outgoing call edges.
pub fn upsert_symbol(conn: &Connection, symbol: &SymbolRow) -> DbResult<()> {
    conn.execute(
        r#"
        INSERT INTO symbols (id, file_path, name, kind, start_line, start_col, end_line, end_col, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            file_path = excluded.file_path,
            name = excluded.name,
            kind = excluded.kind,
            start_line = excluded.start_line,
            start_col = excluded.start_col,
            end_line = excluded.end_line,
            end_col = excluded.end_col,
            language = excluded.language
        "#,
        params![
            symbol.id,
            symbol.file_path,
            symbol.name,
            symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
            symbol.language
        ],
    )?;
    Ok(())
}

/// Batch insert or update symbols within a single transaction, preserving call edges.
pub fn upsert_symbols_batch(conn: &mut Connection, symbols: &[SymbolRow]) -> DbResult<()> {
    if symbols.is_empty() {
        return Ok(());
    }

    super::run_batch_with_write_transaction(conn, |conn| {
        let mut stmt = conn.prepare(
            r#"
            INSERT INTO symbols (id, file_path, name, kind, start_line, start_col, end_line, end_col, language)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                file_path = excluded.file_path,
                name = excluded.name,
                kind = excluded.kind,
                start_line = excluded.start_line,
                start_col = excluded.start_col,
                end_line = excluded.end_line,
                end_col = excluded.end_col,
                language = excluded.language
            "#,
        )?;

        for symbol in symbols {
            stmt.execute(params![
                symbol.id,
                symbol.file_path,
                symbol.name,
                symbol.kind,
                symbol.start_line,
                symbol.start_col,
                symbol.end_line,
                symbol.end_col,
                symbol.language
            ])?;
        }
        Ok(())
    })
}

/// Get all symbols in a file
pub fn get_symbols_by_file(conn: &Connection, file_path: &str) -> DbResult<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, file_path, name, kind, start_line, start_col, end_line, end_col, language
        FROM symbols WHERE file_path = ?
        ORDER BY start_line
        "#,
    )?;

    let rows = stmt.query_map(params![file_path], |row| {
        Ok(SymbolRow {
            id: row.get(0)?,
            file_path: row.get(1)?,
            name: row.get(2)?,
            kind: row.get(3)?,
            start_line: row.get(4)?,
            start_col: row.get(5)?,
            end_line: row.get(6)?,
            end_col: row.get(7)?,
            language: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Find a symbol by name and file path
pub fn get_symbol_by_name(
    conn: &Connection,
    name: &str,
    file_path: &str,
) -> DbResult<Option<SymbolRow>> {
    let result = conn
        .query_row(
            r#"
            SELECT id, file_path, name, kind, start_line, start_col, end_line, end_col, language
            FROM symbols WHERE name = ? AND file_path = ?
            "#,
            params![name, file_path],
            |row| {
                Ok(SymbolRow {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    name: row.get(2)?,
                    kind: row.get(3)?,
                    start_line: row.get(4)?,
                    start_col: row.get(5)?,
                    end_line: row.get(6)?,
                    end_col: row.get(7)?,
                    language: row.get(8)?,
                })
            },
        )
        .optional()?;
    Ok(result)
}

pub fn get_symbols_by_name(conn: &Connection, name: &str) -> DbResult<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, file_path, name, kind, start_line, start_col, end_line, end_col, language
        FROM symbols WHERE name = ?
        "#,
    )?;

    let rows = stmt.query_map(params![name], |row| {
        Ok(SymbolRow {
            id: row.get(0)?,
            file_path: row.get(1)?,
            name: row.get(2)?,
            kind: row.get(3)?,
            start_line: row.get(4)?,
            start_col: row.get(5)?,
            end_line: row.get(6)?,
            end_col: row.get(7)?,
            language: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

pub fn get_symbols_by_name_ci(conn: &Connection, name: &str) -> DbResult<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, file_path, name, kind, start_line, start_col, end_line, end_col, language
        FROM symbols WHERE lower(name) = lower(?)
        "#,
    )?;

    let rows = stmt.query_map(params![name], |row| {
        Ok(SymbolRow {
            id: row.get(0)?,
            file_path: row.get(1)?,
            name: row.get(2)?,
            kind: row.get(3)?,
            start_line: row.get(4)?,
            start_col: row.get(5)?,
            end_line: row.get(6)?,
            end_col: row.get(7)?,
            language: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get all symbols for a branch
pub fn get_symbols_for_branch(conn: &Connection, branch: &str) -> DbResult<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT s.id, s.file_path, s.name, s.kind, s.start_line, s.start_col, s.end_line, s.end_col, s.language
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id
        WHERE bs.branch = ?
        ORDER BY s.start_line
        "#,
    )?;

    let rows = stmt.query_map(params![branch], |row| {
        Ok(SymbolRow {
            id: row.get(0)?,
            file_path: row.get(1)?,
            name: row.get(2)?,
            kind: row.get(3)?,
            start_line: row.get(4)?,
            start_col: row.get(5)?,
            end_line: row.get(6)?,
            end_col: row.get(7)?,
            language: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get symbols for specific files on a branch
pub fn get_symbols_for_files(
    conn: &Connection,
    file_paths: &[String],
    branch: &str,
) -> DbResult<Vec<SymbolRow>> {
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for chunk in file_paths.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            r#"
            SELECT s.id, s.file_path, s.name, s.kind, s.start_line, s.start_col, s.end_line, s.end_col, s.language
            FROM symbols s
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id
            WHERE bs.branch = ? AND s.file_path IN ({})
            ORDER BY s.start_line
            "#,
            placeholders
        );
        let params = rusqlite::params_from_iter(
            std::iter::once(branch).chain(chunk.iter().map(|s| s.as_str())),
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params, |row| {
            Ok(SymbolRow {
                id: row.get(0)?,
                file_path: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                start_line: row.get(4)?,
                start_col: row.get(5)?,
                end_line: row.get(6)?,
                end_col: row.get(7)?,
                language: row.get(8)?,
            })
        })?;

        for row in rows {
            results.push(row?);
        }
    }

    Ok(results)
}

/// Delete all symbols for a file
pub fn delete_symbols_by_file(conn: &Connection, file_path: &str) -> DbResult<usize> {
    let count = conn.execute(
        "DELETE FROM symbols WHERE file_path = ?",
        params![file_path],
    )?;
    Ok(count)
}

// ============================================================================
// Call Edge Operations (Call Graph)
// ============================================================================

/// Branch-scoped view of `call_edges`, with the branch bound as `?1`.
///
/// Edge rows are shared because their ids derive from the caller symbol, which
/// is itself content-addressed. The resolved target is not shared: a branch's
/// `branch_call_edges` row wins, otherwise the legacy shared target is used
/// only while that symbol is a member of the branch.
const BRANCH_EDGES_SOURCE: &str = r#"(
    SELECT e.id, e.from_symbol_id, e.target_name,
           t.symbol_id AS to_symbol_id,
           e.call_type, e.confidence, e.line, e.col,
           CASE WHEN t.symbol_id IS NULL THEN 0 ELSE 1 END AS is_resolved
    FROM call_edges e
    LEFT JOIN branch_call_edges o ON o.branch = ?1 AND o.edge_id = e.id
    LEFT JOIN branch_symbols t ON t.branch = ?1
        AND t.symbol_id = CASE WHEN o.edge_id IS NULL THEN e.to_symbol_id ELSE o.to_symbol_id END
)"#;

/// Fallback for stores that no writer with the overlay has opened yet.
const LEGACY_BRANCH_EDGES_SOURCE: &str = r#"(
    SELECT e.id, e.from_symbol_id, e.target_name,
           t.symbol_id AS to_symbol_id,
           e.call_type, e.confidence, e.line, e.col,
           CASE WHEN t.symbol_id IS NULL THEN 0 ELSE 1 END AS is_resolved
    FROM call_edges e
    LEFT JOIN branch_symbols t ON t.branch = ?1 AND t.symbol_id = e.to_symbol_id
)"#;

fn branch_edges_source(conn: &Connection) -> DbResult<&'static str> {
    Ok(if has_branch_call_edges(conn)? {
        BRANCH_EDGES_SOURCE
    } else {
        LEGACY_BRANCH_EDGES_SOURCE
    })
}

/// Replace `{EDGES}` in `sql` with the branch-scoped edge source, which binds
/// the branch as `?1`.
pub(crate) fn with_branch_edges_source(conn: &Connection, sql: &str) -> DbResult<String> {
    Ok(sql.replace("{EDGES}", branch_edges_source(conn)?))
}

const UPSERT_CALL_EDGE_SQL: &str = r#"
    INSERT INTO call_edges (id, from_symbol_id, target_name, to_symbol_id, call_type, confidence, line, col, is_resolved)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(id) DO UPDATE SET
        from_symbol_id = excluded.from_symbol_id,
        target_name = excluded.target_name,
        to_symbol_id = excluded.to_symbol_id,
        call_type = excluded.call_type,
        confidence = excluded.confidence,
        line = excluded.line,
        col = excluded.col,
        is_resolved = excluded.is_resolved
"#;

/// Pin every other branch that shares the edge and has no overlay row yet to
/// the current shared target, before this write changes it.
const FREEZE_OTHER_BRANCH_TARGETS_SQL: &str = r#"
    INSERT OR IGNORE INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved)
    SELECT bs.branch, ce.id, ce.to_symbol_id, ce.is_resolved
    FROM call_edges ce
    INNER JOIN branch_symbols bs ON bs.symbol_id = ce.from_symbol_id
    WHERE ce.id = ?1 AND bs.branch <> ?2 AND ce.to_symbol_id IS NOT ?3
"#;

const UPSERT_BRANCH_TARGET_SQL: &str = r#"
    INSERT INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved)
    SELECT ?1, ce.id, ?3, ?4 FROM call_edges ce WHERE ce.id = ?2
    ON CONFLICT(branch, edge_id) DO UPDATE SET
        to_symbol_id = excluded.to_symbol_id,
        is_resolved = excluded.is_resolved
"#;

/// Branch writers update an existing row instead of inserting it, so the
/// `branch_call_edges_legacy_write` trigger only fires for writers that do not
/// record branch targets.
const UPDATE_CALL_EDGE_SQL: &str = r#"
    UPDATE call_edges SET
        from_symbol_id = ?2,
        target_name = ?3,
        to_symbol_id = ?4,
        call_type = ?5,
        confidence = ?6,
        line = ?7,
        col = ?8,
        is_resolved = ?9
    WHERE id = ?1
"#;

const INSERT_CALL_EDGE_SQL: &str = r#"
    INSERT INTO call_edges (id, from_symbol_id, target_name, to_symbol_id, call_type, confidence, line, col, is_resolved)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
"#;

const CLEAR_STALE_EDGE_SQL: &str =
    "DELETE FROM branch_call_edges_stale WHERE branch = ?1 AND edge_id = ?2";

struct BranchEdgeStatements<'conn> {
    branch: &'conn str,
    freeze: rusqlite::Statement<'conn>,
    update_edge: rusqlite::Statement<'conn>,
    insert_edge: rusqlite::Statement<'conn>,
    upsert_target: rusqlite::Statement<'conn>,
    clear_stale: Option<rusqlite::Statement<'conn>>,
}

enum CallEdgeWriter<'conn> {
    Shared { upsert_edge: rusqlite::Statement<'conn> },
    Branch(BranchEdgeStatements<'conn>),
}

impl<'conn> CallEdgeWriter<'conn> {
    fn new(conn: &'conn Connection, branch: Option<&'conn str>) -> DbResult<Self> {
        Ok(match branch {
            Some(branch) if has_branch_call_edges(conn)? => {
                let clear_stale = if has_branch_call_edges_stale(conn)? {
                    Some(conn.prepare(CLEAR_STALE_EDGE_SQL)?)
                } else {
                    None
                };
                Self::Branch(BranchEdgeStatements {
                    branch,
                    freeze: conn.prepare(FREEZE_OTHER_BRANCH_TARGETS_SQL)?,
                    update_edge: conn.prepare(UPDATE_CALL_EDGE_SQL)?,
                    insert_edge: conn.prepare(INSERT_CALL_EDGE_SQL)?,
                    upsert_target: conn.prepare(UPSERT_BRANCH_TARGET_SQL)?,
                    clear_stale,
                })
            }
            _ => Self::Shared {
                upsert_edge: conn.prepare(UPSERT_CALL_EDGE_SQL)?,
            },
        })
    }

    fn freeze(&mut self, edge_id: &str, to_symbol_id: Option<&str>) -> DbResult<()> {
        if let Self::Branch(statements) = self {
            statements
                .freeze
                .execute(params![edge_id, statements.branch, to_symbol_id])?;
        }
        Ok(())
    }

    fn set_branch_target(
        &mut self,
        edge_id: &str,
        to_symbol_id: Option<&str>,
        is_resolved: bool,
    ) -> DbResult<()> {
        if let Self::Branch(statements) = self {
            statements.upsert_target.execute(params![
                statements.branch,
                edge_id,
                to_symbol_id,
                is_resolved as i32
            ])?;
            if let Some(clear_stale) = statements.clear_stale.as_mut() {
                clear_stale.execute(params![statements.branch, edge_id])?;
            }
        }
        Ok(())
    }

    fn write(&mut self, edge: &CallEdgeRow) -> DbResult<()> {
        let to_symbol_id = edge.to_symbol_id.as_deref();
        let values = params![
            edge.id,
            edge.from_symbol_id,
            edge.target_name,
            edge.to_symbol_id,
            edge.call_type,
            edge.confidence,
            edge.line,
            edge.col,
            edge.is_resolved as i32
        ];
        match self {
            Self::Shared { upsert_edge } => {
                upsert_edge.execute(values)?;
                return Ok(());
            }
            Self::Branch(statements) => {
                statements
                    .freeze
                    .execute(params![edge.id, statements.branch, to_symbol_id])?;
                if statements.update_edge.execute(values)? == 0 {
                    statements.insert_edge.execute(values)?;
                }
            }
        }
        self.set_branch_target(&edge.id, to_symbol_id, edge.is_resolved)
    }
}

fn run_in_transaction<T>(
    conn: &Connection,
    operation: impl FnOnce(&Connection) -> DbResult<T>,
) -> DbResult<T> {
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        let result = operation(&tx)?;
        tx.commit()?;
        Ok(result)
    } else {
        operation(conn)
    }
}

/// Insert or update a call edge shared by every branch (legacy write).
#[cfg(test)]
pub fn upsert_call_edge(conn: &Connection, edge: &CallEdgeRow) -> DbResult<()> {
    upsert_call_edge_for_branch(conn, edge, None)
}

/// Insert or update a call edge and, when `branch` is set, record its target
/// for that branch without changing what other branches resolve.
pub fn upsert_call_edge_for_branch(
    conn: &Connection,
    edge: &CallEdgeRow,
    branch: Option<&str>,
) -> DbResult<()> {
    run_in_transaction(conn, |conn| CallEdgeWriter::new(conn, branch)?.write(edge))
}

/// Batch insert or update call edges shared by every branch (legacy write).
#[cfg(test)]
pub fn upsert_call_edges_batch(conn: &mut Connection, edges: &[CallEdgeRow]) -> DbResult<()> {
    upsert_call_edges_batch_for_branch(conn, edges, None)
}

/// Batch insert or update call edges within a single transaction, recording
/// each target for `branch` when it is set.
pub fn upsert_call_edges_batch_for_branch(
    conn: &mut Connection,
    edges: &[CallEdgeRow],
    branch: Option<&str>,
) -> DbResult<()> {
    if edges.is_empty() {
        return Ok(());
    }

    super::run_batch_with_write_transaction(conn, |conn| {
        let mut writer = CallEdgeWriter::new(conn, branch)?;
        for edge in edges {
            writer.write(edge)?;
        }
        Ok(())
    })
}

/// Give `to_branch` exactly `from_branch`'s targets for every edge whose caller
/// `from_branch` contains, including dropping `to_branch` rows where
/// `from_branch` reads the legacy target, and remove `to_branch` rows for
/// callers it no longer contains.
pub(crate) fn copy_branch_call_edge_targets(
    conn: &Connection,
    from_branch: &str,
    to_branch: &str,
) -> DbResult<usize> {
    if !has_branch_call_edges(conn)? {
        return Ok(0);
    }
    delete_unreachable_branch_call_edges(conn, Some(to_branch))?;
    conn.execute(
        r#"
        DELETE FROM branch_call_edges
        WHERE branch = ?2
          AND edge_id IN (
            SELECT ce.id
            FROM call_edges ce
            INNER JOIN branch_symbols bs ON bs.branch = ?1 AND bs.symbol_id = ce.from_symbol_id
          )
        "#,
        params![from_branch, to_branch],
    )?;
    let copied = conn.execute(
        r#"
        INSERT INTO branch_call_edges (branch, edge_id, to_symbol_id, is_resolved)
        SELECT ?2, o.edge_id, o.to_symbol_id, o.is_resolved
        FROM branch_call_edges o
        INNER JOIN call_edges ce ON ce.id = o.edge_id
        INNER JOIN branch_symbols bs ON bs.branch = ?1 AND bs.symbol_id = ce.from_symbol_id
        WHERE o.branch = ?1
        ON CONFLICT(branch, edge_id) DO UPDATE SET
            to_symbol_id = excluded.to_symbol_id,
            is_resolved = excluded.is_resolved
        "#,
        params![from_branch, to_branch],
    )?;
    if has_branch_call_edges_stale(conn)? {
        conn.execute(
            r#"
            DELETE FROM branch_call_edges_stale
            WHERE branch = ?2
              AND edge_id IN (
                SELECT ce.id
                FROM call_edges ce
                INNER JOIN branch_symbols bs ON bs.branch = ?1 AND bs.symbol_id = ce.from_symbol_id
              )
            "#,
            params![from_branch, to_branch],
        )?;
        conn.execute(
            r#"
            INSERT OR IGNORE INTO branch_call_edges_stale (branch, edge_id)
            SELECT ?2, st.edge_id
            FROM branch_call_edges_stale st
            INNER JOIN call_edges ce ON ce.id = st.edge_id
            INNER JOIN branch_symbols bs ON bs.branch = ?1 AND bs.symbol_id = ce.from_symbol_id
            WHERE st.branch = ?1
            "#,
            params![from_branch, to_branch],
        )?;
    }
    Ok(copied)
}

/// Which overlay rows an unreachable-row delete examines.
#[derive(Clone, Copy)]
pub(crate) enum UnreachableScope {
    /// The rows of the branch bound to `?1`.
    Branch,
    /// Every row.
    All,
    /// The rows queued in `branch_call_edges_pending_gc`.
    Pending,
}

/// The delete of `table` (`branch_call_edges` or `branch_call_edges_stale`)
/// rows in `scope` whose edge is gone or whose caller left their branch.
pub(crate) fn unreachable_branch_call_edges_sql(table: &str, scope: UnreachableScope) -> String {
    let unreachable = |row: &str| {
        format!(
            "NOT EXISTS (
                SELECT 1
                FROM call_edges ce
                INNER JOIN branch_symbols bs
                    ON bs.symbol_id = ce.from_symbol_id AND bs.branch = {row}.branch
                WHERE ce.id = {row}.edge_id
            )"
        )
    };
    match scope {
        // A literal `branch = ?` keeps the branch-leading key usable; an
        // `(? IS NULL OR branch = ?)` filter makes SQLite read every overlay row.
        UnreachableScope::Branch => {
            format!(
                "DELETE FROM {table} WHERE branch = ?1 AND {}",
                unreachable(table)
            )
        }
        UnreachableScope::All => format!("DELETE FROM {table} WHERE {}", unreachable(table)),
        // CROSS JOIN keeps the queue as the outer loop, so the delete reads
        // only queued rows even where the planner has no table statistics.
        UnreachableScope::Pending => format!(
            "DELETE FROM {table} WHERE rowid IN (
                SELECT o.rowid
                FROM branch_call_edges_pending_gc q
                CROSS JOIN {table} o
                WHERE o.branch = q.branch AND o.edge_id = q.edge_id AND {}
            )",
            unreachable("o")
        ),
    }
}

fn delete_unreachable_branch_call_edges(
    conn: &Connection,
    branch: Option<&str>,
) -> DbResult<usize> {
    let scope = if branch.is_some() {
        UnreachableScope::Branch
    } else {
        UnreachableScope::All
    };
    let params = rusqlite::params_from_iter(branch);
    let count = conn.execute(
        &unreachable_branch_call_edges_sql("branch_call_edges", scope),
        params.clone(),
    )?;
    if has_branch_call_edges_stale(conn)? {
        conn.execute(
            &unreachable_branch_call_edges_sql("branch_call_edges_stale", scope),
            params,
        )?;
    }
    if branch.is_none() {
        conn.execute(
            "DELETE FROM metadata WHERE key = ?1",
            params![BRANCH_CALL_EDGES_SWEEP_PENDING_KEY],
        )?;
    }
    if branch.is_none() && has_branch_call_edges_pending_gc(conn)? {
        // No unreachable row is left for the queue to name.
        conn.execute("DELETE FROM branch_call_edges_pending_gc", [])?;
    }
    Ok(count)
}

/// Delete edge targets and stale marks whose edge is gone or whose caller is no
/// longer a member of their branch: in `branch` only, or in every branch for
/// `None`. The seed fallback runs it for the branch it emptied. The all-branch
/// pass reads every overlay row, so it runs once, at the first drain after the
/// queue is installed, and otherwise belongs to maintenance GC, where it
/// repairs rows that no queue recorded.
pub fn gc_unreachable_branch_call_edges(
    conn: &Connection,
    branch: Option<&str>,
) -> DbResult<usize> {
    if !has_branch_call_edges(conn)? {
        return Ok(0);
    }
    delete_unreachable_branch_call_edges(conn, branch)
}

/// Delete the queued edge targets and stale marks that are still unreachable,
/// then empty the queue. The delete triggers queue the rows that writers
/// without overlay cleanup (0.34.0) orphan; a row whose edge and caller
/// membership were restored before this runs stays. Ordinary refresh runs it
/// through the orphan GCs, at the cost of the queued rows only.
pub fn gc_pending_branch_call_edges(conn: &Connection) -> DbResult<usize> {
    if !has_branch_call_edges(conn)? || !has_branch_call_edges_pending_gc(conn)? {
        return Ok(0);
    }
    let sweep_pending = conn
        .query_row(
            "SELECT 1 FROM metadata WHERE key = ?1",
            params![BRANCH_CALL_EDGES_SWEEP_PENDING_KEY],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if sweep_pending {
        // The install's one all-branch sweep also covers every queued row.
        return delete_unreachable_branch_call_edges(conn, None);
    }
    let count = conn.execute(
        &unreachable_branch_call_edges_sql("branch_call_edges", UnreachableScope::Pending),
        [],
    )?;
    if has_branch_call_edges_stale(conn)? {
        conn.execute(
            &unreachable_branch_call_edges_sql(
                "branch_call_edges_stale",
                UnreachableScope::Pending,
            ),
            [],
        )?;
    }
    conn.execute("DELETE FROM branch_call_edges_pending_gc", [])?;
    Ok(count)
}

/// Delete edge targets and stale marks in every branch for the call edges
/// `edge_ids_sql` selects, before those edges are deleted.
pub(crate) fn delete_branch_call_edges_for_edges(conn: &Connection, edge_ids_sql: &str) -> DbResult<usize> {
    if !has_branch_call_edges(conn)? {
        return Ok(0);
    }
    let count = conn.execute(
        &format!("DELETE FROM branch_call_edges WHERE edge_id IN ({edge_ids_sql})"),
        [],
    )?;
    if has_branch_call_edges_stale(conn)? {
        conn.execute(
            &format!("DELETE FROM branch_call_edges_stale WHERE edge_id IN ({edge_ids_sql})"),
            [],
        )?;
    }
    Ok(count)
}

/// Sorted, distinct file paths of the callers of `branch`'s stale edges: the
/// files a legacy write changed since this branch last wrote their edges.
pub fn get_stale_call_edge_file_paths(conn: &Connection, branch: &str) -> DbResult<Vec<String>> {
    if !has_branch_call_edges_stale(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        r#"
        SELECT DISTINCT s.file_path
        FROM branch_call_edges_stale st
        INNER JOIN call_edges ce ON ce.id = st.edge_id
        INNER JOIN symbols s ON s.id = ce.from_symbol_id
        WHERE st.branch = ?1
        ORDER BY s.file_path
        "#,
    )?;
    let rows = stmt.query_map(params![branch], |row| row.get::<_, String>(0))?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Clear `branch`'s stale marks for edges whose caller is in `file_paths`.
pub fn clear_stale_call_edges_for_files(
    conn: &mut Connection,
    branch: &str,
    file_paths: &[String],
) -> DbResult<usize> {
    if file_paths.is_empty() || !has_branch_call_edges_stale(conn)? {
        return Ok(0);
    }
    super::run_batch_with_write_transaction(conn, |conn| {
        let mut total = 0;
        for chunk in file_paths.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                r#"
                DELETE FROM branch_call_edges_stale
                WHERE branch = ? AND edge_id IN (
                    SELECT ce.id FROM call_edges ce
                    INNER JOIN symbols s ON s.id = ce.from_symbol_id
                    WHERE s.file_path IN ({})
                )
                "#,
                placeholders
            );
            let values = std::iter::once(branch).chain(chunk.iter().map(|s| s.as_str()));
            total += conn.execute(&sql, rusqlite::params_from_iter(values))?;
        }
        Ok(total)
    })
}

fn is_case_insensitive_language(language: &str) -> bool {
    // Keep this aligned with the SQL IN lists below and CASE_INSENSITIVE_LANGUAGES in the indexer.
    matches!(language, "apex" | "php")
}

fn symbol_names_match(language: &str, left: &str, right: &str) -> bool {
    if is_case_insensitive_language(language) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

/// Get all call edges calling a symbol name (filtered by branch).
/// Name matching follows the source symbol's language semantics.
pub fn get_callers(
    conn: &Connection,
    symbol_name: &str,
    branch: &str,
    call_type_filter: Option<&str>,
) -> DbResult<Vec<CallEdgeRow>> {
    let (sql, params) = if let Some(ct) = call_type_filter {
        (
            r#"
            SELECT ce.id, ce.from_symbol_id, ce.target_name, ce.to_symbol_id, ce.call_type, ce.confidence, ce.line, ce.col, ce.is_resolved
            FROM {EDGES} ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE (
                (s.language IN ('apex', 'php') AND ce.target_name = ?2 COLLATE NOCASE)
                OR
                (s.language NOT IN ('apex', 'php') AND ce.target_name = ?2 COLLATE BINARY)
                OR EXISTS (
                    SELECT 1
                    FROM symbols target
                    INNER JOIN branch_symbols target_bs
                        ON target.id = target_bs.symbol_id AND target_bs.branch = ?1
                    WHERE target.id = ce.to_symbol_id
                      AND (
                          (target.language IN ('apex', 'php') AND target.name = ?2 COLLATE NOCASE)
                          OR
                          (target.language NOT IN ('apex', 'php') AND target.name = ?2 COLLATE BINARY)
                      )
                )
            ) AND ce.call_type = ?3
            "#,
            vec![branch.to_string(), symbol_name.to_string(), ct.to_string()],
        )
    } else {
        (
            r#"
            SELECT ce.id, ce.from_symbol_id, ce.target_name, ce.to_symbol_id, ce.call_type, ce.confidence, ce.line, ce.col, ce.is_resolved
            FROM {EDGES} ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE
                (s.language IN ('apex', 'php') AND ce.target_name = ?2 COLLATE NOCASE)
                OR
                (s.language NOT IN ('apex', 'php') AND ce.target_name = ?2 COLLATE BINARY)
                OR EXISTS (
                    SELECT 1
                    FROM symbols target
                    INNER JOIN branch_symbols target_bs
                        ON target.id = target_bs.symbol_id AND target_bs.branch = ?1
                    WHERE target.id = ce.to_symbol_id
                      AND (
                          (target.language IN ('apex', 'php') AND target.name = ?2 COLLATE NOCASE)
                          OR
                          (target.language NOT IN ('apex', 'php') AND target.name = ?2 COLLATE BINARY)
                      )
                )
            "#,
            vec![branch.to_string(), symbol_name.to_string()],
        )
    };

    let sql = with_branch_edges_source(conn, sql)?;
    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(CallEdgeRow {
            id: row.get(0)?,
            from_symbol_id: row.get(1)?,
            target_name: row.get(2)?,
            to_symbol_id: row.get(3)?,
            call_type: row.get(4)?,
            confidence: row.get(5)?,
            line: row.get(6)?,
            col: row.get(7)?,
            is_resolved: row.get::<_, i32>(8)? != 0,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

pub fn get_callers_with_context(
    conn: &Connection,
    symbol_name: &str,
    branch: &str,
    call_type_filter: Option<&str>,
) -> DbResult<Vec<CallerRow>> {
    let (sql, params) = if let Some(ct) = call_type_filter {
        (
            r#"
            SELECT
                ce.id,
                ce.from_symbol_id,
                s.name,
                s.file_path,
                ce.target_name,
                ce.to_symbol_id,
                ce.call_type,
                ce.confidence,
                ce.line,
                ce.col,
                ce.is_resolved
            FROM {EDGES} ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE (
                (s.language IN ('apex', 'php') AND ce.target_name = ?2 COLLATE NOCASE)
                OR
                (s.language NOT IN ('apex', 'php') AND ce.target_name = ?2 COLLATE BINARY)
                OR EXISTS (
                    SELECT 1
                    FROM symbols target
                    INNER JOIN branch_symbols target_bs
                        ON target.id = target_bs.symbol_id AND target_bs.branch = ?1
                    WHERE target.id = ce.to_symbol_id
                      AND (
                          (target.language IN ('apex', 'php') AND target.name = ?2 COLLATE NOCASE)
                          OR
                          (target.language NOT IN ('apex', 'php') AND target.name = ?2 COLLATE BINARY)
                      )
                )
            ) AND ce.call_type = ?3
            "#,
            vec![branch.to_string(), symbol_name.to_string(), ct.to_string()],
        )
    } else {
        (
            r#"
            SELECT
                ce.id,
                ce.from_symbol_id,
                s.name,
                s.file_path,
                ce.target_name,
                ce.to_symbol_id,
                ce.call_type,
                ce.confidence,
                ce.line,
                ce.col,
                ce.is_resolved
            FROM {EDGES} ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE
                (s.language IN ('apex', 'php') AND ce.target_name = ?2 COLLATE NOCASE)
                OR
                (s.language NOT IN ('apex', 'php') AND ce.target_name = ?2 COLLATE BINARY)
                OR EXISTS (
                    SELECT 1
                    FROM symbols target
                    INNER JOIN branch_symbols target_bs
                        ON target.id = target_bs.symbol_id AND target_bs.branch = ?1
                    WHERE target.id = ce.to_symbol_id
                      AND (
                          (target.language IN ('apex', 'php') AND target.name = ?2 COLLATE NOCASE)
                          OR
                          (target.language NOT IN ('apex', 'php') AND target.name = ?2 COLLATE BINARY)
                      )
                )
            "#,
            vec![branch.to_string(), symbol_name.to_string()],
        )
    };

    let sql = with_branch_edges_source(conn, sql)?;
    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(CallerRow {
            id: row.get(0)?,
            from_symbol_id: row.get(1)?,
            from_symbol_name: row.get(2)?,
            from_symbol_file_path: row.get(3)?,
            target_name: row.get(4)?,
            to_symbol_id: row.get(5)?,
            call_type: row.get(6)?,
            confidence: row.get(7)?,
            line: row.get(8)?,
            col: row.get(9)?,
            is_resolved: row.get::<_, i32>(10)? != 0,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get all call edges from a symbol (filtered by branch)
pub fn get_callees(
    conn: &Connection,
    symbol_id: &str,
    branch: &str,
    call_type_filter: Option<&str>,
) -> DbResult<Vec<CallEdgeRow>> {
    let (sql, params) = if let Some(ct) = call_type_filter {
        (
            r#"
            SELECT ce.id, ce.from_symbol_id, ce.target_name, ce.to_symbol_id, ce.call_type, ce.confidence, ce.line, ce.col, ce.is_resolved
            FROM {EDGES} ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE ce.from_symbol_id = ?2 AND ce.call_type = ?3
            "#,
            vec![branch.to_string(), symbol_id.to_string(), ct.to_string()],
        )
    } else {
        (
            r#"
            SELECT ce.id, ce.from_symbol_id, ce.target_name, ce.to_symbol_id, ce.call_type, ce.confidence, ce.line, ce.col, ce.is_resolved
            FROM {EDGES} ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE ce.from_symbol_id = ?2
            "#,
            vec![branch.to_string(), symbol_id.to_string()],
        )
    };

    let sql = with_branch_edges_source(conn, sql)?;
    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(CallEdgeRow {
            id: row.get(0)?,
            from_symbol_id: row.get(1)?,
            target_name: row.get(2)?,
            to_symbol_id: row.get(3)?,
            call_type: row.get(4)?,
            confidence: row.get(5)?,
            line: row.get(6)?,
            col: row.get(7)?,
            is_resolved: row.get::<_, i32>(8)? != 0,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Fingerprint the resolved call edges of every file on a branch, as
/// (file path, fingerprint) pairs ordered by file path. Call edge rows are
/// shared by every branch whose caller symbol is identical, so a branch can
/// compare these against the fingerprints it recorded to detect rows that
/// another branch has since rewritten.
pub fn get_call_edge_fingerprints_for_branch(
    conn: &Connection,
    branch: &str,
) -> DbResult<Vec<(String, String)>> {
    let sql = with_branch_edges_source(
        conn,
        r#"
        SELECT s.file_path, ce.id, COALESCE(ce.to_symbol_id, '')
        FROM branch_symbols bs
        INNER JOIN symbols s ON s.id = bs.symbol_id
        INNER JOIN {EDGES} ce ON ce.from_symbol_id = s.id
        WHERE bs.branch = ?1
        ORDER BY s.file_path, ce.id
        "#,
    )?;
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![branch])?;
    let mut results: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, Xxh3)> = None;
    while let Some(row) = rows.next()? {
        let file_path: String = row.get(0)?;
        let edge_id: String = row.get(1)?;
        let to_symbol_id: String = row.get(2)?;
        if current
            .as_ref()
            .map(|(path, _)| path != &file_path)
            .unwrap_or(true)
        {
            if let Some((path, hasher)) = current.take() {
                results.push((path, format!("{:016x}", hasher.digest())));
            }
            current = Some((file_path, Xxh3::new()));
        }
        let (_, hasher) = current.as_mut().expect("current file is set");
        hasher.update(edge_id.as_bytes());
        hasher.update(b"=");
        hasher.update(to_symbol_id.as_bytes());
        hasher.update(b"\n");
    }
    if let Some((path, hasher)) = current {
        results.push((path, format!("{:016x}", hasher.digest())));
    }
    Ok(results)
}

/// Delete all call edges where the source symbol is in a file
pub fn delete_call_edges_by_file(conn: &Connection, file_path: &str) -> DbResult<usize> {
    if has_branch_call_edges(conn)? {
        conn.execute(
            r#"
            DELETE FROM branch_call_edges WHERE edge_id IN (
                SELECT ce.id FROM call_edges ce
                INNER JOIN symbols s ON s.id = ce.from_symbol_id
                WHERE s.file_path = ?1
            )
            "#,
            params![file_path],
        )?;
    }
    if has_branch_call_edges_stale(conn)? {
        conn.execute(
            r#"
            DELETE FROM branch_call_edges_stale WHERE edge_id IN (
                SELECT ce.id FROM call_edges ce
                INNER JOIN symbols s ON s.id = ce.from_symbol_id
                WHERE s.file_path = ?1
            )
            "#,
            params![file_path],
        )?;
    }
    let count = conn.execute(
        r#"
        DELETE FROM call_edges WHERE from_symbol_id IN (
            SELECT id FROM symbols WHERE file_path = ?
        )
        "#,
        params![file_path],
    )?;
    Ok(count)
}

/// Clear resolved call targets that point at symbols being deleted.
pub fn clear_call_edge_targets_for_symbols(
    conn: &Connection,
    symbol_ids: &[String],
) -> DbResult<usize> {
    if symbol_ids.is_empty() {
        return Ok(0);
    }

    let has_overlay = has_branch_call_edges(conn)?;
    let mut total = 0;
    for chunk in symbol_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE call_edges SET to_symbol_id = NULL, is_resolved = 0 WHERE to_symbol_id IN ({})",
            placeholders
        );
        total += conn.execute(&sql, rusqlite::params_from_iter(chunk.iter()))?;
        if has_overlay {
            let overlay_sql = format!(
                "UPDATE branch_call_edges SET to_symbol_id = NULL, is_resolved = 0 WHERE to_symbol_id IN ({})",
                placeholders
            );
            conn.execute(&overlay_sql, rusqlite::params_from_iter(chunk.iter()))?;
        }
    }

    Ok(total)
}

/// Resolve a call edge by setting the target symbol shared by every branch.
#[cfg(test)]
pub fn resolve_call_edge(conn: &Connection, edge_id: &str, to_symbol_id: &str) -> DbResult<()> {
    resolve_call_edge_for_branch(conn, edge_id, to_symbol_id, None)
}

/// Resolve a call edge and, when `branch` is set, record the target for that
/// branch without changing what other branches resolve.
pub fn resolve_call_edge_for_branch(
    conn: &Connection,
    edge_id: &str,
    to_symbol_id: &str,
    branch: Option<&str>,
) -> DbResult<()> {
    run_in_transaction(conn, |conn| {
        let mut writer = CallEdgeWriter::new(conn, branch)?;
        writer.freeze(edge_id, Some(to_symbol_id))?;
        conn.execute(
            "UPDATE call_edges SET to_symbol_id = ?1, is_resolved = 1 WHERE id = ?2",
            params![to_symbol_id, edge_id],
        )?;
        writer.set_branch_target(edge_id, Some(to_symbol_id), true)
    })
}

/// A single hop in a shortest path between two symbols
#[derive(Debug, Clone)]
pub struct PathHopRow {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub line: u32,
    pub call_type: String,
}

/// Find the shortest call path from a source symbol to a target symbol using BFS.
/// Traverses call_edges in the "callees" direction (from_symbol_id → to_symbol_id/target_name),
/// filtered by branch via branch_symbols.
/// Returns the path as a Vec of hops (source → ... → target), or empty if no path exists.
/// `max_depth` caps the BFS depth to prevent runaway traversals.
pub fn find_shortest_path(
    conn: &Connection,
    from_name: &str,
    to_name: &str,
    branch: &str,
    max_depth: u32,
) -> DbResult<Vec<PathHopRow>> {
    use std::collections::{HashMap, VecDeque};

    // Find all source symbols matching from_name on this branch
    let mut start_stmt = conn.prepare(
        r#"
        SELECT s.id, s.name, s.file_path, s.start_line, s.language
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
        WHERE
            (s.language IN ('apex', 'php') AND s.name = ?2 COLLATE NOCASE)
            OR
            (s.language NOT IN ('apex', 'php') AND s.name = ?2 COLLATE BINARY)
        "#,
    )?;
    let starts: Vec<(String, String, String, u32, String)> = start_stmt
        .query_map(params![branch, from_name], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    if starts.is_empty() {
        return Ok(Vec::new());
    }

    // Ambiguous source: multiple symbols match from_name on this branch.
    // We cannot determine which one the user means, so report no path.
    if starts.len() > 1 {
        return Ok(Vec::new());
    }

    // Prepare statements for BFS expansion
    // Get callees of a symbol (by symbol_id), filtered by branch
    let callees_sql = with_branch_edges_source(
        conn,
        r#"
        SELECT ce.target_name, ce.to_symbol_id, ce.call_type, ce.line
        FROM {EDGES} ce
        INNER JOIN symbols s ON ce.from_symbol_id = s.id
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
        WHERE ce.from_symbol_id = ?2
        "#,
    )?;
    let mut callees_stmt = conn.prepare(&callees_sql)?;

    // Resolve a target_name to symbol IDs on this branch
    let mut resolve_stmt = conn.prepare(
        r#"
        SELECT s.id, s.name, s.file_path, s.start_line, s.language
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
        WHERE
            (?2 IN ('apex', 'php') AND s.name = ?3 COLLATE NOCASE)
            OR
            (?2 NOT IN ('apex', 'php') AND s.name = ?3 COLLATE BINARY)
        "#,
    )?;

    let mut branch_symbol_language_stmt = conn.prepare(
        r#"
        SELECT s.language
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?
        WHERE s.id = ?
        "#,
    )?;

    // BFS state: queue entries are (symbol_id, language, depth)
    // parent map: symbol_id -> (parent_symbol_id, call_type, line)
    let mut visited: HashMap<String, (String, String, u32)> = HashMap::new(); // child -> (parent_id, call_type, line)
    let mut queue: VecDeque<(String, String, u32)> = VecDeque::new();

    // Seed BFS with all start symbols
    for (sid, _name, _fp, _line, language) in &starts {
        visited.insert(sid.clone(), (String::new(), String::new(), 0)); // sentinel parent
        queue.push_back((sid.clone(), language.clone(), 0));
    }

    let mut target_found: Option<String> = None;

    'bfs: while let Some((current_id, current_language, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }

        // Get callees of current symbol
        let callees: Vec<(String, Option<String>, String, u32)> = callees_stmt
            .query_map(params![branch, &current_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,         // target_name
                    row.get::<_, Option<String>>(1)?, // to_symbol_id
                    row.get::<_, String>(2)?,         // call_type
                    row.get::<_, u32>(3)?,            // line
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (callee_target_name, to_symbol_id, call_type, line) in callees {
            // Check if target_name matches using the current/source symbol's language.
            if symbol_names_match(&current_language, &callee_target_name, to_name) {
                // Resolve the target to real symbol(s) on this branch
                let resolved_targets: Vec<(String, String, String, u32, String)> = resolve_stmt
                    .query_map(params![branch, &current_language, to_name], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, u32>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    })?
                    .filter_map(|r| r.ok())
                    .collect();

                // Determine which target to use:
                // 1. If edge has to_symbol_id and it's among resolved targets, use it
                // 2. If exactly one resolved target (unambiguous), use it
                // 3. Otherwise ambiguous — use synthetic target (consistent with
                //    existing call-graph behavior that keeps ambiguous targets unresolved)
                let chosen_target_id: Option<String> = if let Some(ref edge_resolved) = to_symbol_id
                {
                    if resolved_targets.iter().any(|(id, ..)| id == edge_resolved) {
                        Some(edge_resolved.clone())
                    } else {
                        None
                    }
                } else if resolved_targets.len() == 1 {
                    Some(resolved_targets[0].0.clone())
                } else {
                    None
                };

                if let Some(target_id) = chosen_target_id {
                    if !visited.contains_key(&target_id) {
                        visited.insert(
                            target_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        target_found = Some(target_id);
                        break 'bfs;
                    }
                } else if resolved_targets.is_empty() {
                    // No symbol found at all (external/unindexed target) — use synthetic ID
                    let synthetic_id = format!("__target__{}", callee_target_name);
                    if !visited.contains_key(&synthetic_id) {
                        visited.insert(
                            synthetic_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        target_found = Some(synthetic_id);
                        break 'bfs;
                    }
                }
                // else: ambiguous target (multiple matches, none resolved) — skip,
                // no proven path to a specific symbol
            }

            // If resolved, continue BFS through the resolved symbol (verify it's on branch)
            if let Some(ref resolved_id) = to_symbol_id {
                if !visited.contains_key(resolved_id) {
                    // Verify the resolved symbol exists on this branch and carry its language
                    // into the next BFS expansion.
                    let resolved_language: Option<String> = branch_symbol_language_stmt
                        .query_row(params![branch, resolved_id], |row| row.get(0))
                        .optional()?;
                    if let Some(resolved_language) = resolved_language {
                        visited.insert(
                            resolved_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        queue.push_back((resolved_id.clone(), resolved_language, depth + 1));
                    }
                }
            } else {
                // Unresolved: try resolving by target_name
                // Only traverse if unambiguous (single match) to avoid fabricating paths
                let resolved: Vec<(String, String, String, u32, String)> = resolve_stmt
                    .query_map(
                        params![branch, &current_language, &callee_target_name],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, u32>(3)?,
                                row.get::<_, String>(4)?,
                            ))
                        },
                    )?
                    .filter_map(|r| r.ok())
                    .collect();

                // Only traverse unambiguous (single) resolution to avoid fabricating paths
                // through implementations the call graph never actually resolved
                if resolved.len() == 1 {
                    let (resolved_id, _name, _fp, _line, resolved_language) = &resolved[0];
                    if !visited.contains_key(resolved_id) {
                        visited.insert(
                            resolved_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        queue.push_back((
                            resolved_id.clone(),
                            resolved_language.clone(),
                            depth + 1,
                        ));
                    }
                }
            }
        }
    }

    // Reconstruct path if found
    let Some(end_id) = target_found else {
        return Ok(Vec::new());
    };

    // Build symbol info lookup
    let mut info_stmt =
        conn.prepare("SELECT id, name, file_path, start_line FROM symbols WHERE id = ?")?;

    let mut path: Vec<PathHopRow> = Vec::new();
    let mut current = end_id;

    while let Some(entry) = visited.get(&current) {
        let (parent_id, call_type, _line) = entry.clone();

        // Look up symbol info
        let info: Option<(String, String, String, u32)> = if current.starts_with("__target__") {
            // Synthetic target - use the target name
            Some((current.clone(), to_name.to_string(), String::new(), 0))
        } else {
            info_stmt
                .query_row(params![&current], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, u32>(3)?,
                    ))
                })
                .optional()?
        };

        if let Some((_id, name, file_path, sym_line)) = info {
            path.push(PathHopRow {
                symbol_id: current.clone(),
                symbol_name: name,
                file_path,
                line: sym_line,
                call_type: if parent_id.is_empty() {
                    String::from("source")
                } else {
                    call_type
                },
            });
        }

        if parent_id.is_empty() {
            break; // Reached a start node
        }
        current = parent_id;
    }

    path.reverse();
    Ok(path)
}

// ============================================================================
// Branch Symbol Operations (Call Graph)
// ============================================================================

/// Add symbols to a branch
pub fn add_symbols_to_branch(
    conn: &Connection,
    branch: &str,
    symbol_ids: &[String],
) -> DbResult<()> {
    if symbol_ids.is_empty() {
        return Ok(());
    }

    let mut stmt =
        conn.prepare("INSERT OR IGNORE INTO branch_symbols (branch, symbol_id) VALUES (?, ?)")?;

    for symbol_id in symbol_ids {
        stmt.execute(params![branch, symbol_id])?;
    }
    Ok(())
}

/// Batch add symbols to a branch within a single transaction
pub fn add_symbols_to_branch_batch(
    conn: &mut Connection,
    branch: &str,
    symbol_ids: &[String],
) -> DbResult<()> {
    if symbol_ids.is_empty() {
        return Ok(());
    }

    super::run_batch_with_write_transaction(conn, |conn| {
        let mut stmt =
            conn.prepare("INSERT OR IGNORE INTO branch_symbols (branch, symbol_id) VALUES (?, ?)")?;

        for symbol_id in symbol_ids {
            stmt.execute(params![branch, symbol_id])?;
        }
        Ok(())
    })
}

/// Get all symbol IDs for a branch
pub fn get_branch_symbol_ids(conn: &Connection, branch: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT symbol_id FROM branch_symbols WHERE branch = ?")?;
    let rows = stmt.query_map(params![branch], |row| row.get::<_, String>(0))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Remove all symbols from a branch
pub fn clear_branch_symbols(conn: &Connection, branch: &str) -> DbResult<usize> {
    let count = conn.execute(
        "DELETE FROM branch_symbols WHERE branch = ?",
        params![branch],
    )?;
    Ok(count)
}

/// Return symbol IDs that are still referenced by any branch.
pub fn get_referenced_symbol_ids(
    conn: &Connection,
    symbol_ids: &[String],
) -> DbResult<Vec<String>> {
    if symbol_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for chunk in symbol_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT DISTINCT symbol_id FROM branch_symbols WHERE symbol_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(chunk.iter());
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
        for row in rows {
            results.push(row?);
        }
    }

    Ok(results)
}

/// Remove branch-symbol catalog entries for specific symbol IDs.
pub fn delete_branch_symbols_by_symbol_ids(
    conn: &Connection,
    symbol_ids: &[String],
) -> DbResult<usize> {
    if symbol_ids.is_empty() {
        return Ok(0);
    }

    let has_overlay = has_branch_call_edges(conn)?;
    let has_stale = has_branch_call_edges_stale(conn)?;
    let mut total = 0;
    for chunk in symbol_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        if has_overlay {
            let overlay_sql = format!(
                "DELETE FROM branch_call_edges WHERE edge_id IN (SELECT id FROM call_edges WHERE from_symbol_id IN ({}))",
                placeholders
            );
            conn.execute(&overlay_sql, rusqlite::params_from_iter(chunk.iter()))?;
        }
        if has_stale {
            let stale_sql = format!(
                "DELETE FROM branch_call_edges_stale WHERE edge_id IN (SELECT id FROM call_edges WHERE from_symbol_id IN ({}))",
                placeholders
            );
            conn.execute(&stale_sql, rusqlite::params_from_iter(chunk.iter()))?;
        }
        let sql = format!(
            "DELETE FROM branch_symbols WHERE symbol_id IN ({})",
            placeholders
        );
        total += conn.execute(&sql, rusqlite::params_from_iter(chunk.iter()))?;
    }

    Ok(total)
}

/// Remove branch-symbol catalog entries for specific symbol IDs on a specific branch.
pub fn delete_branch_symbols_for_branch(
    conn: &Connection,
    branch: &str,
    symbol_ids: &[String],
) -> DbResult<usize> {
    if symbol_ids.is_empty() {
        return Ok(0);
    }

    let has_overlay = has_branch_call_edges(conn)?;
    let has_stale = has_branch_call_edges_stale(conn)?;
    let mut total = 0;
    for chunk in symbol_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let branch_params =
            || std::iter::once(branch).chain(chunk.iter().map(|s| s.as_str()));
        if has_overlay {
            let overlay_sql = format!(
                "DELETE FROM branch_call_edges WHERE branch = ? AND edge_id IN (SELECT id FROM call_edges WHERE from_symbol_id IN ({}))",
                placeholders
            );
            conn.execute(&overlay_sql, rusqlite::params_from_iter(branch_params()))?;
        }
        if has_stale {
            let stale_sql = format!(
                "DELETE FROM branch_call_edges_stale WHERE branch = ? AND edge_id IN (SELECT id FROM call_edges WHERE from_symbol_id IN ({}))",
                placeholders
            );
            conn.execute(&stale_sql, rusqlite::params_from_iter(branch_params()))?;
        }
        let sql = format!(
            "DELETE FROM branch_symbols WHERE branch = ? AND symbol_id IN ({})",
            placeholders
        );
        total += conn.execute(&sql, rusqlite::params_from_iter(branch_params()))?;
    }

    Ok(total)
}
