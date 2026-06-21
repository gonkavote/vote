use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::Map;

/// VOTES[(tender_id, voter)] = bid in ngonka. Immutable once set.
pub const VOTES: Map<(&str, &Addr), Uint128> = Map::new("votes");
