pub mod error;
pub mod msg;
pub mod state;

use cosmwasm_std::{
    entry_point, to_json_binary, Binary, Deps, DepsMut, Env, Event, MessageInfo, Response,
    StdResult,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::{ExecuteMsg, GetAccountUidResponse, InstantiateMsg, QueryMsg};
use crate::state::LINKS;

const CONTRACT_NAME: &str = "crates.io:gonka-wallet-link";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Backend format: `u_` prefix + 8 lowercase hex chars — matches `auth.py`.
fn is_valid_uid(uid: &str) -> bool {
    if uid.len() != 10 || !uid.starts_with("u_") {
        return false;
    }
    uid[2..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

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
        ExecuteMsg::LinkAccount { account_uid } => exec_link(deps, info, account_uid),
        ExecuteMsg::UnlinkAccount {} => exec_unlink(deps, info),
    }
}

fn exec_link(
    deps: DepsMut,
    info: MessageInfo,
    account_uid: String,
) -> Result<Response, ContractError> {
    if !is_valid_uid(&account_uid) {
        return Err(ContractError::InvalidAccountUid);
    }
    LINKS.save(deps.storage, &info.sender, &account_uid)?;

    let event = Event::new("wallet_link")
        .add_attribute("wallet", info.sender.as_str())
        .add_attribute("account_uid", &account_uid);

    Ok(Response::new()
        .add_event(event)
        .add_attribute("action", "link_account")
        .add_attribute("wallet", info.sender.as_str())
        .add_attribute("account_uid", account_uid))
}

fn exec_unlink(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    if !LINKS.has(deps.storage, &info.sender) {
        return Err(ContractError::NotLinked);
    }
    LINKS.remove(deps.storage, &info.sender);

    let event = Event::new("wallet_unlink").add_attribute("wallet", info.sender.as_str());

    Ok(Response::new()
        .add_event(event)
        .add_attribute("action", "unlink_account")
        .add_attribute("wallet", info.sender.as_str()))
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetAccountUid { wallet } => {
            let wallet = deps.api.addr_validate(&wallet)?;
            let account_uid = LINKS.may_load(deps.storage, &wallet)?;
            to_json_binary(&GetAccountUidResponse { account_uid })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::{from_json, Addr};

    fn instantiate_contract(deps: DepsMut) {
        let creator = Addr::unchecked("gonka1creator");
        let info = message_info(&creator, &[]);
        instantiate(deps, mock_env(), info, InstantiateMsg {}).unwrap();
    }

    fn link(deps: DepsMut, wallet: &str, uid: &str) -> Result<Response, ContractError> {
        let wallet = Addr::unchecked(wallet);
        let info = message_info(&wallet, &[]);
        execute(
            deps,
            mock_env(),
            info,
            ExecuteMsg::LinkAccount { account_uid: uid.to_string() },
        )
    }

    fn unlink(deps: DepsMut, wallet: &str) -> Result<Response, ContractError> {
        let wallet = Addr::unchecked(wallet);
        let info = message_info(&wallet, &[]);
        execute(deps, mock_env(), info, ExecuteMsg::UnlinkAccount {})
    }

    fn query_uid(deps: Deps, wallet: &str) -> Option<String> {
        let res: GetAccountUidResponse = from_json(
            query(
                deps,
                mock_env(),
                QueryMsg::GetAccountUid { wallet: wallet.to_string() },
            )
            .unwrap(),
        )
        .unwrap();
        res.account_uid
    }

    #[test]
    fn link_stores_mapping_and_emits_event() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        let res = link(deps.as_mut(), "gonka1alice", "u_ebc106ab").unwrap();
        let ev = res.events.iter().find(|e| e.ty == "wallet_link").unwrap();
        assert!(ev.attributes.iter().any(|a| a.key == "account_uid" && a.value == "u_ebc106ab"));
        assert_eq!(query_uid(deps.as_ref(), "gonka1alice"), Some("u_ebc106ab".to_string()));
    }

    #[test]
    fn re_link_overwrites() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        link(deps.as_mut(), "gonka1alice", "u_11111111").unwrap();
        link(deps.as_mut(), "gonka1alice", "u_22222222").unwrap();
        assert_eq!(query_uid(deps.as_ref(), "gonka1alice"), Some("u_22222222".to_string()));
    }

    #[test]
    fn unlink_removes_mapping() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        link(deps.as_mut(), "gonka1alice", "u_ebc106ab").unwrap();
        unlink(deps.as_mut(), "gonka1alice").unwrap();
        assert_eq!(query_uid(deps.as_ref(), "gonka1alice"), None);
    }

    #[test]
    fn unlink_without_link_errors() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        let err = unlink(deps.as_mut(), "gonka1bob").unwrap_err();
        assert_eq!(err, ContractError::NotLinked);
    }

    #[test]
    fn invalid_uid_rejected() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        // Wrong prefix.
        assert_eq!(
            link(deps.as_mut(), "gonka1alice", "x_ebc106ab").unwrap_err(),
            ContractError::InvalidAccountUid
        );
        // Uppercase hex.
        assert_eq!(
            link(deps.as_mut(), "gonka1alice", "u_EBC106AB").unwrap_err(),
            ContractError::InvalidAccountUid
        );
        // Too short.
        assert_eq!(
            link(deps.as_mut(), "gonka1alice", "u_abc").unwrap_err(),
            ContractError::InvalidAccountUid
        );
        // Too long.
        assert_eq!(
            link(deps.as_mut(), "gonka1alice", "u_ebc106abcd").unwrap_err(),
            ContractError::InvalidAccountUid
        );
        // Non-hex char.
        assert_eq!(
            link(deps.as_mut(), "gonka1alice", "u_zbc106ab").unwrap_err(),
            ContractError::InvalidAccountUid
        );
    }

    #[test]
    fn wallets_isolated() {
        let mut deps = mock_dependencies();
        instantiate_contract(deps.as_mut());
        link(deps.as_mut(), "gonka1alice", "u_aaaaaaaa").unwrap();
        link(deps.as_mut(), "gonka1bob", "u_bbbbbbbb").unwrap();
        assert_eq!(query_uid(deps.as_ref(), "gonka1alice"), Some("u_aaaaaaaa".to_string()));
        assert_eq!(query_uid(deps.as_ref(), "gonka1bob"), Some("u_bbbbbbbb".to_string()));
        // Alice unlink doesn't affect Bob.
        unlink(deps.as_mut(), "gonka1alice").unwrap();
        assert_eq!(query_uid(deps.as_ref(), "gonka1alice"), None);
        assert_eq!(query_uid(deps.as_ref(), "gonka1bob"), Some("u_bbbbbbbb".to_string()));
    }
}
