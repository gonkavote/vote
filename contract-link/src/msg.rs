use cosmwasm_schema::{cw_serde, QueryResponses};

#[cw_serde]
pub struct InstantiateMsg {}

#[cw_serde]
pub enum ExecuteMsg {
    /// Link the sender's wallet to an off-chain `account_uid`. Overwrites
    /// any previous link for the same wallet. Format: "u_" + 8 hex chars.
    LinkAccount { account_uid: String },
    /// Unlink the sender's wallet (removes the mapping).
    UnlinkAccount {},
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Look up the account_uid linked to a given wallet address (if any).
    #[returns(GetAccountUidResponse)]
    GetAccountUid { wallet: String },
}

#[cw_serde]
pub struct GetAccountUidResponse {
    pub account_uid: Option<String>,
}
