pub mod error;
pub mod msg;
pub mod state;

use cosmwasm_std::{
    entry_point, to_json_binary, Binary, Deps, DepsMut, Env, Event, MessageInfo, Response,
    StdResult, Uint128,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::{ExecuteMsg, GetVoteResponse, InstantiateMsg, QueryMsg};
use crate::state::VOTES;

const CONTRACT_NAME: &str = "crates.io:gonka-tenders";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

const TENDER_ID_MAX_LEN: usize = 64;

/// 1 GNK in ngonka. amounts must be positive whole multiples of this.
const NGONKA_PER_GNK: u128 = 1_000_000_000;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Vote { tender_id, amount } => exec_vote(deps, info, tender_id, amount),
    }
}

fn exec_vote(
    deps: DepsMut,
    info: MessageInfo,
    tender_id: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if tender_id.is_empty() || tender_id.len() > TENDER_ID_MAX_LEN {
        return Err(ContractError::InvalidTenderId);
    }

    let amt = amount.u128();
    if amt == 0 || amt % NGONKA_PER_GNK != 0 {
        return Err(ContractError::InvalidAmount);
    }

    let key = (tender_id.as_str(), &info.sender);
    if VOTES.has(deps.storage, key) {
        return Err(ContractError::AlreadyVoted);
    }
    VOTES.save(deps.storage, key, &amount)?;

    let event = Event::new("vote")
        .add_attribute("tender_id", &tender_id)
        .add_attribute("voter", info.sender.as_str())
        .add_attribute("amount", amount.to_string());

    Ok(Response::new()
        .add_event(event)
        .add_attribute("action", "vote")
        .add_attribute("tender_id", tender_id)
        .add_attribute("voter", info.sender.as_str())
        .add_attribute("amount", amount.to_string()))
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetVote { tender_id, voter } => {
            let voter = deps.api.addr_validate(&voter)?;
            let amount = VOTES.may_load(deps.storage, (tender_id.as_str(), &voter))?;
            to_json_binary(&GetVoteResponse { amount })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::{from_json, Addr};

    const ONE_GNK: u128 = NGONKA_PER_GNK;

    fn instantiate_contract(deps: DepsMut) {
        let creator = Addr::unchecked("gonka1creator");
        let info = message_info(&creator, &[]);
        instantiate(deps, mock_env(), info, InstantiateMsg {}).unwrap();
    }

    fn vote(
        deps: DepsMut,
        voter: &str,
        tender_id: &str,
        amount: u128,
    ) -> Result<Response, ContractError> {
        let voter = Addr::unchecked(voter);
        let info = message_info(&voter, &[]);
        execute(
            deps,
            mock_env(),
            info,
            ExecuteMsg::Vote {
                tender_id: tender_id.to_string(),
                amount: Uint128::new(amount),
            },
        )
    }

    fn query_vote(deps: Deps, tender_id: &str, voter: &str) -> Option<Uint128> {
        let res: GetVoteResponse = from_json(
            query(
                deps,
                mock_env(),
                QueryMsg::GetVote {
                    tender_id: tender_id.to_string(),
                    voter: voter.to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        res.amount
    }

    #[test]
    fn vote_creates_record() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());

        let res = vote(deps.as_mut(), "gonka1alice", "abc-123", 5 * ONE_GNK).unwrap();
        let ev = res.events.iter().find(|e| e.ty == "vote").unwrap();
        assert!(ev.attributes.iter().any(|a| a.key == "tender_id" && a.value == "abc-123"));
        assert!(ev.attributes
            .iter()
            .any(|a| a.key == "amount" && a.value == (5 * ONE_GNK).to_string()));

        assert_eq!(
            query_vote(deps.as_ref(), "abc-123", "gonka1alice"),
            Some(Uint128::new(5 * ONE_GNK))
        );
    }

    #[test]
    fn re_vote_rejected() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());

        vote(deps.as_mut(), "gonka1alice", "t1", ONE_GNK).unwrap();
        let err = vote(deps.as_mut(), "gonka1alice", "t1", 99 * ONE_GNK).unwrap_err();
        assert_eq!(err, ContractError::AlreadyVoted);

        // Original bid unchanged.
        assert_eq!(query_vote(deps.as_ref(), "t1", "gonka1alice"), Some(Uint128::new(ONE_GNK)));
    }

    #[test]
    fn votes_isolated_per_tender() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());

        vote(deps.as_mut(), "gonka1alice", "t1", ONE_GNK).unwrap();
        vote(deps.as_mut(), "gonka1alice", "t2", 7 * ONE_GNK).unwrap();

        assert_eq!(query_vote(deps.as_ref(), "t1", "gonka1alice"), Some(Uint128::new(ONE_GNK)));
        assert_eq!(query_vote(deps.as_ref(), "t2", "gonka1alice"), Some(Uint128::new(7 * ONE_GNK)));
    }

    #[test]
    fn votes_isolated_per_voter() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());

        vote(deps.as_mut(), "gonka1alice", "t1", 2 * ONE_GNK).unwrap();
        vote(deps.as_mut(), "gonka1bob", "t1", 8 * ONE_GNK).unwrap();

        assert_eq!(query_vote(deps.as_ref(), "t1", "gonka1alice"), Some(Uint128::new(2 * ONE_GNK)));
        assert_eq!(query_vote(deps.as_ref(), "t1", "gonka1bob"), Some(Uint128::new(8 * ONE_GNK)));
    }

    #[test]
    fn missing_vote_returns_none() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        assert_eq!(query_vote(deps.as_ref(), "missing", "gonka1alice"), None);
    }

    #[test]
    fn empty_tender_id_rejected() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        let err = vote(deps.as_mut(), "gonka1alice", "", ONE_GNK).unwrap_err();
        assert_eq!(err, ContractError::InvalidTenderId);
    }

    #[test]
    fn long_tender_id_rejected() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        let long_id = "x".repeat(TENDER_ID_MAX_LEN + 1);
        let err = vote(deps.as_mut(), "gonka1alice", &long_id, ONE_GNK).unwrap_err();
        assert_eq!(err, ContractError::InvalidTenderId);
    }

    #[test]
    fn zero_amount_rejected() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        let err = vote(deps.as_mut(), "gonka1alice", "t1", 0).unwrap_err();
        assert_eq!(err, ContractError::InvalidAmount);
    }

    #[test]
    fn fractional_gnk_rejected() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        // 1.5 GNK = 1_500_000_000 ngonka — not a whole multiple.
        let err = vote(deps.as_mut(), "gonka1alice", "t1", 1_500_000_000).unwrap_err();
        assert_eq!(err, ContractError::InvalidAmount);
    }

    #[test]
    fn sub_one_gnk_rejected() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        let err = vote(deps.as_mut(), "gonka1alice", "t1", 999_999_999).unwrap_err();
        assert_eq!(err, ContractError::InvalidAmount);
    }
}
