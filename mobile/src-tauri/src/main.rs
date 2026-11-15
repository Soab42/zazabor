// Prevents an extra console window on Windows in release; the phone app never runs there.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zazabor_wallet_lib::run()
}
