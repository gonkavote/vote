use cosmwasm_std::Addr;
use cw_storage_plus::Map;

/// LINKS[wallet] = account_uid. Sender-owned: only the wallet itself can
/// overwrite or clear its mapping (enforced in exec_link/exec_unlink).
pub const LINKS: Map<&Addr, String> = Map::new("links");
