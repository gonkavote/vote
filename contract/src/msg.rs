use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

#[cw_serde]
pub struct InstantiateMsg {}

#[cw_serde]
pub enum ExecuteMsg {
    /// Cast a one-time vote on `tender_id` with a declarative bid expressed
    /// in ngonka (1 GNK = 10^9 ngonka). Must be a positive whole number of GNK.
    Vote {
        tender_id: String,
        amount: Uint128,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(GetVoteResponse)]
    GetVote { tender_id: String, voter: String },
}

#[cw_serde]
pub struct GetVoteResponse {
    pub amount: Option<Uint128>,
}
