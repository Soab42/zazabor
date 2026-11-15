//! Zazabor Wallet for Android: the desktop's wallet (`src-tauri/src/wallet`) on its own.
//!
//! The ledger code is compiled in from the desktop tree by path, so both apps share one
//! implementation. The few things it borrows from the rest of the desktop app are stood in for
//! below with the same names and paths.

#[path = "../../../src-tauri/src/wallet/mod.rs"]
mod wallet;

/// Ids and clock, as the desktop's Notes module has them.
mod notes {
    pub fn now() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }

    /// 128 random bits as 32 hex digits.
    pub fn new_id() -> String {
        use std::hash::{BuildHasher, Hasher};
        let part = || {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            h.finish()
        };
        format!("{:016x}{:016x}", part(), part())
    }
}

/// Reading and safely replacing files, as the desktop's Files module has it.
mod fs {
    pub mod text {
        use std::path::Path;

        pub fn read_bytes(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
            let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
            if !meta.is_file() {
                return Err(format!("{} is not a file", path.display()));
            }
            if meta.len() > max_bytes {
                return Err(format!("{} is too large", path.display()));
            }
            std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
        }

        /// Writes beside the file and renames over it, so a failed save leaves the old file whole.
        pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<f64, String> {
            let shown = path.display();
            let dir = path.parent().ok_or_else(|| format!("Can’t save {shown}"))?;
            let name = path.file_name().ok_or_else(|| format!("Can’t save {shown}"))?.to_string_lossy();
            let tmp = dir.join(format!(".{name}.{}.save", std::process::id()));
            std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("Can’t save {shown}: {e}")
            })?;
            Ok(crate::notes::now() as f64 / 1000.0)
        }
    }
}

#[path = "../../../src-tauri/src/office/delimited.rs"]
mod delimited;

mod office {
    pub(crate) use crate::delimited::{parse_delimited, quote_field};
}

/// The phone has no Time tracker, so there are no hours to earn from.
mod time {
    pub struct ProjectHours {
        pub project: String,
        pub minutes: i64,
    }

    pub fn project_minutes(_from: i64, _to: i64) -> Vec<ProjectHours> {
        Vec::new()
    }
}

/// The phone's own screen lock guards the app; there is no Zazabor lock here.
pub(crate) fn ensure_unlocked() -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_barcode_scanner::init())
        .setup(|app| {
            wallet::init(app.handle().clone(), app.path().app_data_dir()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // The desktop registers the same list in `src-tauri/src/lib.rs`.
            wallet::wallet_state,
            wallet::wallet_account_save,
            wallet::wallet_account_archive,
            wallet::wallet_account_delete,
            wallet::wallet_rate_set,
            wallet::wallet_category_save,
            wallet::wallet_category_delete,
            wallet::wallet_tx_list,
            wallet::wallet_tx_save,
            wallet::wallet_tx_delete,
            wallet::wallet_tx_set_category,
            wallet::wallet_transfer_save,
            wallet::wallet_transfer,
            wallet::wallet_parse,
            wallet::wallet_budgets,
            wallet::wallet_budget_set,
            wallet::wallet_budgets_copy,
            wallet::wallet_by_category,
            wallet::wallet_months,
            wallet::wallet_backups,
            wallet::wallet_backup_now,
            wallet::wallet_backup_restore,
            wallet::wallet_category_archive,
            wallet::wallet_budget_rollover,
            wallet::wallet_bills,
            wallet::wallet_bill_save,
            wallet::wallet_bill_pause,
            wallet::wallet_bill_delete,
            wallet::wallet_bill_pay,
            wallet::wallet_bill_skip,
            wallet::wallet_cards,
            wallet::wallet_plans,
            wallet::wallet_plan,
            wallet::wallet_plan_preview,
            wallet::wallet_plan_save,
            wallet::wallet_plan_pay,
            wallet::wallet_plan_delete,
            wallet::wallet_plan_payment_save,
            wallet::wallet_plan_import,
            wallet::wallet_fdrs,
            wallet::wallet_fdr_save,
            wallet::wallet_fdr_receive,
            wallet::wallet_fdr_delete,
            wallet::wallet_plan_payment_delete,
            wallet::wallet_receipts,
            wallet::wallet_receipt_attach,
            wallet::wallet_receipt_remove,
            wallet::wallet_import_preview,
            wallet::wallet_import_commit,
            wallet::wallet_import_undo,
            wallet::wallet_import_batches,
            wallet::wallet_profiles,
            wallet::wallet_profile_save,
            wallet::wallet_profile_delete,
            wallet::wallet_rules,
            wallet::wallet_rule_save,
            wallet::wallet_rule_delete,
            wallet::wallet_export,
            wallet::wallet_earnings,
            wallet::wallet_project_rate_set,
            wallet::wallet_earnings_post,
            wallet::wallet_sync_info,
            wallet::wallet_sync_invite,
            wallet::wallet_sync_cancel_invite,
            wallet::wallet_sync_join,
            wallet::wallet_sync_now,
            wallet::wallet_sync_forget,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zazabor Wallet");
}
