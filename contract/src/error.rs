use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("tender_id must be 1..=64 chars")]
    InvalidTenderId,

    #[error("amount must be a positive multiple of 1 GNK (1_000_000_000 ngonka)")]
    InvalidAmount,

    #[error("address has already voted on this tender")]
    AlreadyVoted,
}
