use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("account_uid must match /^u_[a-f0-9]{{8}}$/")]
    InvalidAccountUid,

    #[error("wallet is not linked")]
    NotLinked,
}
