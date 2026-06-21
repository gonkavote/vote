// Pretty labels for Cosmos / Gonka message type URLs.
//
// `HUMAN_LABELS` is a copy of tracker.gonka.vip's mapping (one source of
// truth across the two sites). `humanMsgLabel(typeUrl, t)` looks the URL up
// and translates the result through the i18n layer — keys live under
// `governance.msg.*` so adding a new language is just adding new strings to
// common.json. Unknown URLs fall through `fallbackLabel` (CamelCase split).
import type { TFunction } from 'i18next'

// Stable short key per typeUrl, used as the i18n key suffix.
const KEYS: Record<string, string> = {
  // Cosmos SDK — bank
  '/cosmos.bank.v1beta1.MsgSend': 'send',
  '/cosmos.bank.v1beta1.MsgMultiSend': 'multiSend',
  '/cosmos.bank.v1beta1.MsgUpdateParams': 'updateParamsBank',

  // Cosmos SDK — authz
  '/cosmos.authz.v1beta1.MsgGrant': 'grantPermission',
  '/cosmos.authz.v1beta1.MsgRevoke': 'revokePermission',
  '/cosmos.authz.v1beta1.MsgExec': 'authzExec',

  // Cosmos SDK — gov
  '/cosmos.gov.v1.MsgVote': 'vote',
  '/cosmos.gov.v1beta1.MsgVote': 'vote',
  '/cosmos.gov.v1.MsgDeposit': 'proposalDeposit',
  '/cosmos.gov.v1.MsgSubmitProposal': 'submitProposal',
  '/cosmos.gov.v1.MsgUpdateParams': 'updateParamsGov',
  '/cosmos.gov.v1.MsgExecLegacyContent': 'execLegacyContent',
  '/cosmos.gov.v1beta1.TextProposal': 'textProposal',

  // Cosmos SDK — slashing
  '/cosmos.slashing.v1beta1.MsgUnjail': 'unjailValidator',
  '/cosmos.slashing.v1beta1.MsgUpdateParams': 'updateParamsSlashing',

  // Cosmos SDK — staking
  '/cosmos.staking.v1beta1.MsgDelegate': 'delegate',
  '/cosmos.staking.v1beta1.MsgUndelegate': 'undelegate',
  '/cosmos.staking.v1beta1.MsgBeginRedelegate': 'redelegate',
  '/cosmos.staking.v1beta1.MsgCreateValidator': 'createValidator',
  '/cosmos.staking.v1beta1.MsgEditValidator': 'editValidator',
  '/cosmos.staking.v1beta1.MsgUpdateParams': 'updateParamsStaking',

  // Cosmos SDK — distribution
  '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward': 'withdrawReward',
  '/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission': 'withdrawCommission',
  '/cosmos.distribution.v1beta1.MsgCommunityPoolSpend': 'communityPoolSpend',
  '/cosmos.distribution.v1beta1.MsgFundCommunityPool': 'fundCommunityPool',
  '/cosmos.distribution.v1beta1.MsgUpdateParams': 'updateParamsDistribution',

  // Cosmos SDK — mint
  '/cosmos.mint.v1beta1.MsgUpdateParams': 'updateParamsMint',

  // Cosmos SDK — upgrade
  '/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade': 'softwareUpgrade',
  '/cosmos.upgrade.v1beta1.MsgCancelUpgrade': 'cancelUpgrade',
  '/cosmos.upgrade.v1beta1.SoftwareUpgradeProposal': 'softwareUpgrade',

  // CosmWasm
  '/cosmwasm.wasm.v1.MsgExecuteContract': 'contractExecute',
  '/cosmwasm.wasm.v1.MsgInstantiateContract': 'contractInstantiate',
  '/cosmwasm.wasm.v1.MsgInstantiateContract2': 'contractInstantiate2',
  '/cosmwasm.wasm.v1.MsgStoreCode': 'contractStoreCode',
  '/cosmwasm.wasm.v1.MsgMigrateContract': 'contractMigrate',
  '/cosmwasm.wasm.v1.MsgUpdateAdmin': 'contractUpdateAdmin',
  '/cosmwasm.wasm.v1.MsgClearAdmin': 'contractClearAdmin',
  '/cosmwasm.wasm.v1.MsgUpdateParams': 'updateParamsWasm',

  // IBC core
  '/ibc.core.client.v1.MsgUpdateClient': 'ibcUpdateClient',
  '/ibc.core.client.v1.MsgRecoverClient': 'ibcRecoverClient',
  '/ibc.core.client.v1.MsgUpgradeClient': 'ibcUpgradeClient',

  // Gonka — collateral
  '/inference.collateral.MsgDepositCollateral': 'collateralDeposit',
  '/inference.collateral.MsgWithdrawCollateral': 'collateralWithdraw',
  '/inference.collateral.MsgUpdateParams': 'updateParamsCollateral',

  // Gonka — restrictions
  '/inference.restrictions.MsgUpdateParams': 'updateParamsRestrictions',

  // Gonka — streamvesting
  '/inference.streamvesting.MsgBatchTransferWithVesting': 'batchTransferWithVesting',
  '/inference.streamvesting.MsgUpdateParams': 'updateParamsStreamvesting',

  // Gonka — bookkeeper
  '/inference.bookkeeper.MsgUpdateParams': 'updateParamsBookkeeper',

  // Gonka — inference module
  '/inference.inference.MsgStartInference': 'inferenceStart',
  '/inference.inference.MsgFinishInference': 'inferenceFinish',
  '/inference.inference.MsgValidation': 'inferenceValidation',
  '/inference.inference.MsgInvalidateInference': 'inferenceInvalidate',
  '/inference.inference.MsgRevalidateInference': 'inferenceRevalidate',
  '/inference.inference.MsgClaimRewards': 'claimRewards',
  '/inference.inference.MsgSubmitPocBatch': 'pocBatchV1',
  '/inference.inference.MsgSubmitPocValidation': 'pocValidationV1',
  '/inference.inference.MsgPoCV2StoreCommit': 'pocCommit',
  '/inference.inference.MsgPoCV2Validation': 'pocValidation',
  '/inference.inference.MsgSubmitSeed': 'submitSeed',
  '/inference.inference.MsgBridgeExchange': 'bridgeExchange',
  '/inference.inference.MsgSubmitNewUnfundedParticipant': 'newParticipant',
  '/inference.inference.MsgSubmitHardwareDiff': 'hardwareUpdate',
  '/inference.inference.MsgUpdateParams': 'updateParamsInference',
  '/inference.inference.MsgRegisterModel': 'registerModel',
  '/inference.inference.MsgRegisterIbcTokenMetadata': 'registerIbcTokenMetadata',
  '/inference.inference.MsgApproveIbcTokenForTrading': 'approveIbcTokenForTrading',
  '/inference.inference.MsgAddParticipantsToAllowList': 'addParticipantsToAllowList',
  '/inference.inference.MsgRemoveParticipantsFromAllowList': 'removeParticipantsFromAllowList',

  // Gonka — training
  '/inference.inference.MsgSubmitTrainingKvRecord': 'trainingKvRecord',
  '/inference.inference.MsgJoinTraining': 'joinTraining',
  '/inference.inference.MsgJoinTrainingStatus': 'trainingStatus',
  '/inference.inference.MsgTrainingHeartbeat': 'trainingHeartbeat',
  '/inference.inference.MsgSetBarrier': 'trainingBarrier',
  '/inference.inference.MsgClaimTrainingTaskForAssignment': 'claimTrainingTask',
  '/inference.inference.MsgAssignTrainingTask': 'assignTrainingTask',

  // Gonka — threshold signing / DKG
  '/inference.inference.MsgSubmitDealerPart': 'dkgDealerPart',
  '/inference.inference.MsgSubmitVerificationVector': 'dkgVerificationVector',
  '/inference.inference.MsgRequestThresholdSignature': 'thresholdSignatureRequest',
  '/inference.inference.MsgSubmitPartialSignature': 'partialSignature',
  '/inference.inference.MsgSubmitGroupKeyValidationSignature': 'groupKeyValidation',
}

function fallbackLabel(typeUrl: string): string {
  const tail = typeUrl.split('.').pop() || typeUrl
  const stripped = tail.startsWith('Msg') ? tail.slice(3) : tail
  return stripped.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ') || tail
}

/** Translate a Cosmos type_url into a human-friendly, i18n-aware label. */
export function humanMsgLabel(typeUrl: string, t: TFunction): string {
  if (!typeUrl) return '—'
  const key = KEYS[typeUrl]
  if (key) {
    return t(`governance.msg.${key}`, { defaultValue: fallbackLabel(typeUrl) })
  }
  return fallbackLabel(typeUrl)
}
