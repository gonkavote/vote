// WalletConnect v2 client + Cosmos signDirect helpers.
//
// projectId, chain_id and the public site URL come from /api/config at
// runtime (see setRuntimeConfig() below). They MUST be set before the
// first call to getSignClient() / castVote() / castGovVote(); App.tsx
// wires that up after the Config query resolves.

import SignClient from '@walletconnect/sign-client'
import type { SessionTypes } from '@walletconnect/types'
import { getSdkError } from '@walletconnect/utils'
import { TxBody, AuthInfo, SignDoc, TxRaw, Fee, ModeInfo, SignerInfo } from 'cosmjs-types/cosmos/tx/v1beta1/tx'
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing'
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys'
import { Any } from 'cosmjs-types/google/protobuf/any'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { MsgVote } from 'cosmjs-types/cosmos/gov/v1beta1/tx'
import { VoteOption } from 'cosmjs-types/cosmos/gov/v1beta1/gov'

export const SIGN_METHOD = 'cosmos_signDirect'
export const ACCOUNTS_METHOD = 'cosmos_getAccounts'

// Gonka-wallet deep link — same scheme regardless of deploy.
export const GONKA_WALLET_DEEP_LINK_BASE = 'gonka://wc'
export const GONKA_WALLET_HOME = 'https://wallet.gonka.vip/'

interface RuntimeConfig {
  wcProjectId: string
  chainId: string
  caipChainId: string
  appName: string
  appDescription: string
  appUrl: string
  appIcon: string
}

let _runtime: RuntimeConfig | null = null

/**
 * Wire the values pulled from /api/config into wc.ts. Idempotent — calling
 * twice with the same values is fine; subsequent calls with DIFFERENT
 * values reset the cached SignClient so the next connect uses the new
 * projectId.
 */
export function setRuntimeConfig(cfg: {
  wcProjectId: string
  chainId: string
  publicBaseUrl: string
}): void {
  const url = (cfg.publicBaseUrl || '').replace(/\/+$/, '') || window.location.origin
  const next: RuntimeConfig = {
    wcProjectId: cfg.wcProjectId,
    chainId: cfg.chainId,
    caipChainId: `cosmos:${cfg.chainId}`,
    appName: 'Gonka Vote',
    appDescription: 'Community voting on Gonka proposals',
    appUrl: url,
    appIcon: `${url}/images/logo.png`,
  }
  if (_runtime && _runtime.wcProjectId === next.wcProjectId
      && _runtime.chainId === next.chainId
      && _runtime.appUrl === next.appUrl) {
    return
  }
  _runtime = next
  _client = null // force re-init with the new metadata
}

function rt(): RuntimeConfig {
  if (!_runtime) {
    throw new Error('wc.ts used before setRuntimeConfig() — call it from App boot.')
  }
  return _runtime
}

let _client: Promise<SignClient> | null = null

export function getSignClient(): Promise<SignClient> {
  if (!_client) {
    const r = rt()
    _client = SignClient.init({
      projectId: r.wcProjectId,
      relayUrl: 'wss://relay.walletconnect.com',
      metadata: {
        name: r.appName,
        description: r.appDescription,
        url: r.appUrl,
        icons: [r.appIcon],
      },
    })
  }
  return _client
}

export interface ConnectResult {
  uri: string
  approval: () => Promise<SessionTypes.Struct>
}

/** Trigger a fresh WC pairing handshake. Returns the wc: URI to render in
 *  the QR + the promise that resolves once the wallet approves. */
export async function connect(): Promise<ConnectResult> {
  const client = await getSignClient()
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      cosmos: {
        chains: [rt().caipChainId],
        methods: [SIGN_METHOD, ACCOUNTS_METHOD],
        events: ['accountsChanged', 'chainChanged'],
      },
    },
  })
  if (!uri) throw new Error('WalletConnect did not return a pairing URI')
  return { uri, approval }
}

export async function disconnect(topic: string): Promise<void> {
  const client = await getSignClient()
  try {
    await client.disconnect({ topic, reason: getSdkError('USER_DISCONNECTED') })
  } catch {
    // Already gone.
  }
}

export interface CosmosAccount {
  address: string  // gonka1…
  pubkey: Uint8Array  // 33 bytes secp256k1 compressed
  algo: 'secp256k1'
}

interface RawCosmosAccount {
  address: string
  pubkey: string  // base64
  algo: string
}

export async function getAccount(session: SessionTypes.Struct): Promise<CosmosAccount> {
  const client = await getSignClient()
  const result = await client.request<RawCosmosAccount[]>({
    topic: session.topic,
    chainId: rt().caipChainId,
    request: { method: ACCOUNTS_METHOD, params: {} },
  })
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('Wallet returned no accounts')
  }
  const acc = result[0]
  return {
    address: acc.address,
    pubkey: base64ToBytes(acc.pubkey),
    algo: 'secp256k1',
  }
}

// ---------------------------------------------------------------------------
// Build, sign and broadcast MsgExecuteContract
// ---------------------------------------------------------------------------

export interface VoteParams {
  contractAddress: string
  proposalId: string
  amountNgonka: string  // decimal string
  restUrl: string       // /chain-api root
}

interface AccountInfo {
  account_number: string
  sequence: string
}

async function fetchAccountInfo(restUrl: string, address: string): Promise<AccountInfo> {
  const r = await fetch(`${restUrl}/cosmos/auth/v1beta1/accounts/${address}`)
  if (!r.ok) throw new Error(`Account lookup failed (${r.status})`)
  const j = await r.json()
  // Cosmos returns BaseAccount fields directly under .account.
  // Some other account variants (vesting, etc.) wrap them under .account.value.
  const a = j.account?.value ?? j.account ?? {}
  // Vesting account variant nests the BaseAccount one level deeper.
  const base = a.base_account ?? a
  return {
    account_number: String(base.account_number ?? '0'),
    sequence: String(base.sequence ?? '0'),
  }
}

export interface BroadcastResult {
  txhash: string
  code: number
  raw_log?: string
}

/**
 * Wrap one Any message into a SignDirect tx, ask the wallet to sign it via
 * WalletConnect, then broadcast via REST. Used by both castVote (CosmWasm
 * MsgExecuteContract → proposal) and castGovVote (Cosmos gov MsgVote).
 */
async function _signAndBroadcast(
  session: SessionTypes.Struct,
  account: CosmosAccount,
  restUrl: string,
  msgAny: Any,
): Promise<BroadcastResult> {
  // TxBody.
  const txBody = TxBody.fromPartial({
    messages: [msgAny],
    memo: '',
    timeoutHeight: 0n,
    extensionOptions: [],
    nonCriticalExtensionOptions: [],
  })
  const bodyBytes = TxBody.encode(txBody).finish()

  // AuthInfo with the user's pubkey + zero fee (chain has 0 fee).
  const pubkeyAny = Any.fromPartial({
    typeUrl: '/cosmos.crypto.secp256k1.PubKey',
    value: PubKey.encode(PubKey.fromPartial({ key: account.pubkey })).finish(),
  })
  const { account_number, sequence } = await fetchAccountInfo(restUrl, account.address)
  const signerInfo = SignerInfo.fromPartial({
    publicKey: pubkeyAny,
    modeInfo: ModeInfo.fromPartial({ single: { mode: SignMode.SIGN_MODE_DIRECT } }),
    sequence: BigInt(sequence),
  })
  const fee = Fee.fromPartial({
    amount: [{ denom: 'ngonka', amount: '0' }],
    gasLimit: 250_000n,
    payer: '',
    granter: '',
  })
  const authInfo = AuthInfo.fromPartial({ signerInfos: [signerInfo], fee })
  const authInfoBytes = AuthInfo.encode(authInfo).finish()

  // Hand the SignDoc to the wallet via WalletConnect.
  const client = await getSignClient()
  const signResult = await client.request<{
    signature: { signature: string }
    signed: { bodyBytes: string; authInfoBytes: string }
  }>({
    topic: session.topic,
    chainId: rt().caipChainId,
    request: {
      method: SIGN_METHOD,
      params: {
        signerAddress: account.address,
        signDoc: {
          chainId: rt().chainId,
          accountNumber: account_number,
          bodyBytes: bytesToBase64(bodyBytes),
          authInfoBytes: bytesToBase64(authInfoBytes),
        },
      },
    },
  })

  // Assemble signed TxRaw and broadcast via REST. Wallet may have re-encoded
  // body/authInfo (defaults injected), so trust the version it sent back.
  const signedBody = base64ToBytes(signResult.signed.bodyBytes)
  const signedAuth = base64ToBytes(signResult.signed.authInfoBytes)
  const sigBytes = base64ToBytes(signResult.signature.signature)
  const txRaw = TxRaw.fromPartial({
    bodyBytes: signedBody,
    authInfoBytes: signedAuth,
    signatures: [sigBytes],
  })
  const txBytes = TxRaw.encode(txRaw).finish()

  const broadcastResp = await fetch(`${restUrl}/cosmos/tx/v1beta1/txs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tx_bytes: bytesToBase64(txBytes),
      mode: 'BROADCAST_MODE_SYNC',
    }),
  })
  if (!broadcastResp.ok) {
    const err = await broadcastResp.text()
    throw new Error(`Broadcast failed (${broadcastResp.status}): ${err}`)
  }
  const broadcastJson = await broadcastResp.json()
  const tx = broadcastJson.tx_response ?? {}
  return { txhash: tx.txhash ?? '', code: Number(tx.code ?? 0), raw_log: tx.raw_log }
}


export async function castVote(
  session: SessionTypes.Struct,
  account: CosmosAccount,
  params: VoteParams,
): Promise<BroadcastResult> {
  const voteJson = JSON.stringify({
    vote: { tender_id: params.proposalId, amount: params.amountNgonka },
  })
  const msg = MsgExecuteContract.fromPartial({
    sender: account.address,
    contract: params.contractAddress,
    msg: new TextEncoder().encode(voteJson),
    funds: [],
  })
  const msgAny = Any.fromPartial({
    typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
    value: MsgExecuteContract.encode(msg).finish(),
  })
  return _signAndBroadcast(session, account, params.restUrl, msgAny)
}


// ---------------------------------------------------------------------------
// Governance: cosmos.gov.v1beta1.MsgVote
// ---------------------------------------------------------------------------

export type GovVoteOption = 'yes' | 'no' | 'abstain' | 'no_with_veto'

const GOV_OPTION_ENUM: Record<GovVoteOption, VoteOption> = {
  yes: VoteOption.VOTE_OPTION_YES,
  abstain: VoteOption.VOTE_OPTION_ABSTAIN,
  no: VoteOption.VOTE_OPTION_NO,
  no_with_veto: VoteOption.VOTE_OPTION_NO_WITH_VETO,
}

export interface GovVoteParams {
  proposalId: number
  option: GovVoteOption
  restUrl: string
}

export async function castGovVote(
  session: SessionTypes.Struct,
  account: CosmosAccount,
  params: GovVoteParams,
): Promise<BroadcastResult> {
  const msg = MsgVote.fromPartial({
    proposalId: BigInt(params.proposalId),
    voter: account.address,
    option: GOV_OPTION_ENUM[params.option],
  })
  const msgAny = Any.fromPartial({
    typeUrl: '/cosmos.gov.v1beta1.MsgVote',
    value: MsgVote.encode(msg).finish(),
  })
  return _signAndBroadcast(session, account, params.restUrl, msgAny)
}

// ---------------------------------------------------------------------------
// base64 helpers — works in both browser and tests, no Buffer dep.
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Build the deep link URL the Gonka mobile wallet expects. */
export function gonkaWalletDeepLink(wcUri: string): string {
  return `${GONKA_WALLET_DEEP_LINK_BASE}?uri=${encodeURIComponent(wcUri)}`
}
