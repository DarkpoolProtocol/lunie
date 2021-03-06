const _ = require('lodash')
const BigNumber = require('bignumber.js')
const {
  fixDecimalsAndRoundUp,
  fixDecimalsAndRoundUpBigNumbers,
  toViewDenom
} = require('../../common/numbers.js')
const { lunieMessageTypes } = require('../../lib/message-types')

const CHAIN_TO_VIEW_COMMISSION_CONVERSION_FACTOR = 1e-9

const proposalTypeEnum = {
  TEXT: 'TEXT',
  TREASURY: 'TREASURY',
  PARAMETER_CHANGE: 'PARAMETER_CHANGE'
}

function blockReducer(
  networkId,
  chainId,
  blockHeight,
  blockHash,
  sessionIndex,
  blockAuthor,
  transactions,
  data = {}
) {
  return {
    id: blockHash,
    networkId,
    height: blockHeight,
    chainId,
    hash: blockHash,
    sessionIndex,
    time: new Date().toISOString(), // TODO: Get from blockchain state
    transactions,
    proposer_address: blockAuthor,
    data: JSON.stringify(data)
  }
}

function validatorReducer(network, validator) {
  return {
    id: validator.accountId,
    networkId: network.id,
    chainId: network.chain_id,
    operatorAddress: validator.accountId,
    website: validator.identity.web ? validator.identity.web : ``,
    identity: validator.identity.twitter,
    name:
      validator.identity && validator.accountId
        ? identityReducer(validator.accountId, validator.identity)
        : undefined,
    votingPower: validator.votingPower.toFixed(6),
    startHeight: undefined,
    uptimePercentage: undefined,
    tokens: validator.tokens,
    commissionUpdateTime: undefined,
    commission: (
      validator.validatorPrefs.commission *
      CHAIN_TO_VIEW_COMMISSION_CONVERSION_FACTOR
    ).toFixed(6),
    maxCommission: undefined,
    maxChangeCommission: undefined,
    status: validator.status,
    statusDetailed: validator.status.toLowerCase(),
    delegatorShares: undefined,
    selfStake:
      (
        BigNumber(validator.exposure.own).toNumber() *
        network.coinLookup[0].chainToViewConversionFactor
      ).toFixed(6) || 0,
    expectedReturns: validator.expectedReturns,
    nominations: validator.nominations,
    popularity: validator.popularity
  }
}

function identityReducer(address, identity) {
  if (
    identity.displayParent &&
    identity.displayParent !== `` &&
    identity.display &&
    identity.display !== ``
  ) {
    return `${identity.displayParent}/${identity.display}`
  } else {
    return identity.display && identity.display !== ``
      ? identity.display
      : address
  }
}

async function balanceReducer(
  network,
  balance,
  total,
  fiatValueAPI,
  fiatCurrency
) {
  if (total === '0') {
    return []
  }
  const lunieCoin = coinReducer(network, balance, 6)
  const fiatValues = await fiatValueAPI.calculateFiatValues(
    [lunieCoin],
    fiatCurrency
  )
  return [
    {
      id: lunieCoin.denom,
      amount: lunieCoin.amount,
      total: fixDecimalsAndRoundUp(
        BigNumber(total)
          .times(network.coinLookup[0].chainToViewConversionFactor)
          .toNumber(),
        6
      ),
      denom: lunieCoin.denom,
      fiatValue: fiatValues[lunieCoin.denom]
    }
  ]
}

async function balanceV2Reducer(
  network,
  balance,
  total,
  staked,
  fiatValueAPI,
  fiatCurrency
) {
  const availableLunieCoin = coinReducer(network, balance, 6)
  const totalLunieCoin = coinReducer(network, total, 6)
  const stakedLunieCoin = coinReducer(network, staked, 6)
  const availableFiatValue = (
    await fiatValueAPI.calculateFiatValues([availableLunieCoin], fiatCurrency)
  )[availableLunieCoin.denom]
  const totalFiatValue = (
    await fiatValueAPI.calculateFiatValues([totalLunieCoin], fiatCurrency)
  )[totalLunieCoin.denom]

  if (total === '0') {
    return {
      id: availableLunieCoin.denom,
      type: 'STAKE',
      available: 0,
      total: 0,
      staked: 0,
      denom: availableLunieCoin.denom,
      availableFiatValue,
      fiatValue: totalFiatValue
    }
  }

  return {
    id: availableLunieCoin.denom,
    type: 'STAKE', // just a staking denom on Kusama for now
    available: availableLunieCoin.amount,
    total: totalLunieCoin.amount,
    staked: stakedLunieCoin.amount,
    denom: availableLunieCoin.denom,
    availableFiatValue,
    fiatValue: totalFiatValue
  }
}

function delegationReducer(network, delegation, validator, active) {
  return {
    id: validator.operatorAddress,
    validatorAddress: validator.operatorAddress,
    delegatorAddress: delegation.who,
    validator,
    amount: delegation.value
      ? BigNumber(delegation.value)
          .times(network.coinLookup[0].chainToViewConversionFactor)
          .toFixed(6)
      : 0,
    active
  }
}

function undelegationReducer(undelegation, address, network) {
  return {
    id: `${address}_${undelegation.value}`,
    delegatorAddress: address,
    amount: toViewDenom(network, undelegation.value),
    startHeight: '',
    endTime: undelegation.endTime
  }
}

function transactionsReducerV2(
  network,
  extrinsics,
  blockEvents,
  blockHeight,
  reducers
) {
  // Filter Polkadot tx to Lunie supported types
  return extrinsics.reduce((collection, extrinsic, index) => {
    return collection.concat(
      transactionReducerV2(
        network,
        extrinsic,
        index,
        blockEvents,
        blockHeight,
        reducers
      )
    )
  }, [])
}

// Map Polkadot event method to Lunie message types
function getMessageType(section, method) {
  switch (`${section}.${method}`) {
    case 'balances.transfer':
      return lunieMessageTypes.SEND
    case 'lunie.staking':
      return lunieMessageTypes.STAKE
    default:
      return lunieMessageTypes.UNKNOWN
  }
}

function parsePolkadotTransaction(
  hash,
  message,
  messageIndex,
  signer,
  success,
  network,
  blockHeight,
  reducers
) {
  const lunieTransactionType = getMessageType(message.section, message.method)
  return {
    id: hash,
    type: lunieTransactionType,
    hash,
    height: blockHeight,
    key: `${hash}_${messageIndex}`,
    details: transactionDetailsReducer(
      network,
      lunieTransactionType,
      reducers,
      signer,
      message
    ),
    timestamp: new Date().getTime(), // FIXME!: pass it from block, we should get current timestamp from blockchain for new blocks
    memo: ``,
    fees: [
      {
        amount: `0`,
        denom: network.coinLookup[0].viewDenom
      }
    ], // FIXME!
    success,
    log: ``,
    involvedAddresses: reducers.extractInvolvedAddresses(
      lunieTransactionType,
      signer,
      message
    )
  }
}

function getExtrinsicSuccess(extrinsicIndex, blockEvents, isBatch) {
  const events = blockEvents.filter(({ phase }) => {
    return parseInt(phase.toHuman().ApplyExtrinsic) === extrinsicIndex // index is a string
  })
  // if tx is a batch, we need to check if all of the batched txs went through
  if (isBatch) {
    return !!events.find(
      ({ event }) =>
        event.section === `utility` && event.method === `BatchCompleted`
    )
  }
  return !!events.find(
    ({ event }) =>
      event.section === `system` && event.method === `ExtrinsicSuccess`
  )
}

function transactionReducerV2(
  network,
  extrinsic,
  index,
  blockEvents,
  blockHeight,
  reducers
) {
  const hash = extrinsic.hash.toHex()
  const signer = extrinsic.signer.toString()
  const isBatch = extrinsic.method.meta.name.toString() === `batch`
  const messages = aggregateLunieStaking(
    isBatch ? extrinsic.method.args[0] : [extrinsic.method]
  )
  const success = reducers.getExtrinsicSuccess(index, blockEvents, isBatch)
  return messages.map((message, messageIndex) =>
    parsePolkadotTransaction(
      hash,
      message,
      messageIndex,
      signer,
      success,
      network,
      blockHeight,
      reducers
    )
  )
}

// we display staking as one tx where in Polkadot this can be 2
// so we aggregate the messages into 1
// ATTENTION this could be weird for some users
function aggregateLunieStaking(messages) {
  // lunie staking message
  let aggregatedLunieStaking = {
    method: 'staking',
    section: 'lunie',
    validators: [],
    amount: 0
  }
  let hasBond = false
  let hasNominate = false
  let reducedMessages = []
  messages.forEach((current) => {
    if (
      current.toHuman().section === 'staking' &&
      current.toHuman().method === 'bond'
    ) {
      aggregatedLunieStaking.amount =
        aggregatedLunieStaking.amount + current.args.value
      hasBond = true
    }

    if (
      current.toHuman().section === 'staking' &&
      current.toHuman().method === 'bondExtra'
    ) {
      aggregatedLunieStaking.amount =
        aggregatedLunieStaking.amount + current.args.max_additional
      hasBond = true
    }

    if (
      current.toHuman().section === 'staking' &&
      current.toHuman().method === 'nominate'
    ) {
      aggregatedLunieStaking.validators = aggregatedLunieStaking.validators.concat(
        current.args[0].toHuman()
      )
      hasNominate = true
    }
    reducedMessages.push({
      section: current.toHuman().section,
      method: current.toHuman().method,
      args: JSON.parse(JSON.stringify(current.args, null, 2))
    })
  })
  return hasBond && hasNominate
    ? reducedMessages.concat(aggregatedLunieStaking)
    : reducedMessages
}

// Map polkadot messages to our details format
function transactionDetailsReducer(
  network,
  lunieTransactionType,
  reducers,
  signer,
  message
) {
  let details
  switch (lunieTransactionType) {
    case lunieMessageTypes.SEND:
      details = sendDetailsReducer(network, message, signer, reducers)
      break
    case lunieMessageTypes.STAKE:
      details = stakeDetailsReducer(network, message, reducers)
      break
    default:
      details = {}
  }
  return {
    type: lunieTransactionType,
    ...details
  }
}

function coinReducer(network, amount, decimals = 6) {
  if (!amount) {
    return {
      amount: 0,
      denom: ''
    }
  }

  return {
    denom: network.coinLookup[0].viewDenom,
    amount: fixDecimalsAndRoundUp(
      BigNumber(amount).times(
        network.coinLookup[0].chainToViewConversionFactor
      ),
      decimals
    )
  }
}

function sendDetailsReducer(network, message, signer, reducers) {
  return {
    from: [signer],
    to: [message.args[0]],
    amount: reducers.coinReducer(network, message.args[1])
  }
}

// the message for staking is created by `aggregateLunieStaking`
function stakeDetailsReducer(network, message, reducers) {
  return {
    to: message.validators,
    amount: reducers.coinReducer(network, message.amount)
  }
}

function extractInvolvedAddresses(lunieTransactionType, signer, message) {
  let involvedAddresses = []
  if (lunieTransactionType === lunieMessageTypes.SEND) {
    involvedAddresses = involvedAddresses.concat([signer, message.args[0]])
  } else if (lunieTransactionType === lunieMessageTypes.STAKE) {
    involvedAddresses = involvedAddresses.concat([signer], message.validators)
  } else {
    involvedAddresses = involvedAddresses.concat([signer])
  }
  return _.uniq(involvedAddresses)
}

function rewardsReducer(network, validators, rewards, reducers) {
  const allRewards = []
  const validatorsDict = _.keyBy(validators, 'operatorAddress')
  rewards.forEach((reward) => {
    // reward reducer returns an array
    allRewards.push(
      ...reducers.rewardReducer(network, validatorsDict, reward, reducers)
    )
  })
  return allRewards
}

function dbRewardsReducer(validatorsDictionary, dbRewards) {
  const aggregatedRewards = dbRewards.reduce((sum, reward) => {
    sum[reward.validator] = sum[reward.validator] || {}
    sum[reward.validator][reward.denom] =
      (sum[reward.validator][reward.denom] || 0) + reward.amount
    return sum
  }, {})
  const flattenedAggregatedRewards = Object.entries(aggregatedRewards).reduce(
    (sum, [validator, reward]) => {
      sum = sum.concat(
        Object.entries(reward).map(([denom, amount]) => ({
          validator,
          denom,
          amount: amount.toFixed(6)
        }))
      )
      return sum
    },
    []
  )
  return flattenedAggregatedRewards.map((reward) => ({
    ...reward,
    validator: validatorsDictionary[reward.validator]
  }))
}

function rewardReducer(network, validators, reward, reducers) {
  let parsedRewards = []
  Object.entries(reward.validators).forEach((validatorReward) => {
    const validator = validators[validatorReward[0]]
    if (!validator) return
    const lunieReward = {
      id: validatorReward[0],
      ...reducers.coinReducer(network, validatorReward[1].toString(10)),
      height: reward.era,
      address: reward.address,
      validator, // used for user facing rewards in the API
      validatorAddress: validatorReward[0] // added for writing the validator to the db even it it is not in the dictionary
    }
    parsedRewards.push(lunieReward)
  })
  return parsedRewards
}

function depositReducer(deposit, depositer, network) {
  return {
    amount: [
      {
        amount: fixDecimalsAndRoundUpBigNumbers(deposit.balance, 6, network),
        denom: network.stakingDenom
      }
    ],
    depositer
  }
}

function networkAccountReducer(account) {
  return {
    name:
      account && account.identity && account.identity.display
        ? account.identity.display
        : '',
    address: account && account.accountId ? account.accountId : '',
    picture: account ? account.twitter : '' // TODO: get the twitter picture using scriptRunner
  }
}

function democracyProposalReducer(
  network,
  proposal,
  totalIssuance,
  blockHeight,
  detailedVotes,
  proposer
) {
  return {
    id: `democracy-`.concat(proposal.index),
    proposalId: proposal.index,
    networkId: network.id,
    type: proposalTypeEnum.PARAMETER_CHANGE,
    title: `Preliminary Proposal #${proposal.index}`,
    description: proposal.description,
    creationTime: proposal.creationTime,
    status: `DepositPeriod`, // trying to adjust to the Cosmos status
    statusBeginTime: proposal.creationTime,
    tally: democracyTallyReducer(proposal),
    deposit: toViewDenom(network, proposal.balance),
    proposer,
    detailedVotes
  }
}

function democracyReferendumReducer(
  network,
  proposal,
  totalIssuance,
  blockHeight,
  detailedVotes
) {
  return {
    id: `referendum-`.concat(proposal.index),
    proposalId: proposal.index,
    proposer: proposal.proposer,
    networkId: network.id,
    type: proposalTypeEnum.PARAMETER_CHANGE,
    title: `Proposal #${proposal.index}`,
    description: proposal.description,
    creationTime: proposal.creationTime,
    status: `VotingPeriod`,
    statusBeginTime: proposal.creationTime,
    statusEndTime: getStatusEndTime(blockHeight, proposal.status.end),
    tally: tallyReducer(network, proposal.status.tally, totalIssuance),
    deposit: toViewDenom(network, proposal.status.tally.turnout),
    detailedVotes
  }
}

function treasuryProposalReducer(
  network,
  proposal,
  councilMembers,
  blockHeight,
  electionInfo,
  detailedVotes,
  proposer
) {
  return {
    id: `treasury-`.concat(proposal.index || proposal.votes.index),
    proposalId: proposal.index || proposal.votes.index,
    networkId: network.id,
    type: proposalTypeEnum.TREASURY,
    title: `Treasury Proposal #${proposal.index || proposal.votes.index}`,
    description: proposal.description,
    creationTime: proposal.creationTime,
    status: `VotingPeriod`,
    statusEndTime: proposal.votes
      ? getStatusEndTime(blockHeight, proposal.votes.end)
      : null,
    tally: proposal.votes
      ? councilTallyReducer(proposal.votes, councilMembers, electionInfo)
      : {},
    deposit: toViewDenom(network, Number(proposal.deposit)),
    proposer,
    beneficiary: proposal.beneficiary, // the account getting the tip
    detailedVotes
  }
}

function tallyReducer(network, tally, totalIssuance) {
  //
  // tally chain format:
  //
  // "tally": {
  //   "ayes": "0x0000000000000000001e470441298100",
  //   "nays": "0x00000000000000000186de726fc56000",
  //   "turnout": "0x000000000000000000dc3dd9ad3d0800"
  // }
  //
  // turnout is the real amount deposited by voters
  // in polkadot you can vote with "conviction", that means
  // ayes and nays are amplified by the selected lockup period:
  //
  // 1x voting balance, locked for 1x enactment (8.00 days)
  // 2x voting balance, locked for 2x enactment (16.00 days)
  // 3x voting balance, locked for 4x enactment (32.00 days)
  // 4x voting balance, locked for 8x enactment (64.00 days)
  // 5x voting balance, locked for 16x enactment (128.00 days)
  // 6x voting balance, locked for 32x enactment (256.00 days)
  //

  const turnout = BigNumber(tally.turnout)

  const totalVoted = BigNumber(tally.ayes).plus(tally.nays)
  const total = toViewDenom(network, totalVoted.toString(10))
  const yes = toViewDenom(network, tally.ayes)
  const no = toViewDenom(network, tally.nays)
  const totalVotedPercentage = turnout
    .div(BigNumber(totalIssuance))
    .toNumber()
    .toFixed(4) // the percent conversion is done in the FE. We just send the decimals here

  return {
    yes,
    no,
    abstain: 0,
    veto: 0,
    total,
    totalVotedPercentage
  }
}

function councilTallyReducer(votes, councilMembers, electionInfo) {
  const total = votes.ayes.length + votes.nays.length
  // to calculated the totalVotedPercentage we need to add up the voting power of the council members that did vote on the proposal
  // first of all we need to calculate the total voting power of the council
  // TODO: we also need to take into account the Prime council member vote
  const totalCouncilVotingPower = electionInfo.members.reduce(
    (votingPowerAggregator, member) => {
      return (votingPowerAggregator = BigNumber(votingPowerAggregator).plus(
        member[1]
      ))
    },
    0
  )
  const totalVoted = councilMembers.reduce((totalVotedAggregator, member) => {
    const memberElectionInfo = electionInfo.members.find(
      (memberElectionInfo) =>
        memberElectionInfo[0].toHuman() === member.toHuman()
    )
    if (memberElectionInfo) {
      totalVotedAggregator = BigNumber(totalVotedAggregator).plus(
        memberElectionInfo[1]
      )
    }
    return totalVotedAggregator
  }, 0)
  return {
    yes: votes.ayes.length,
    no: votes.nays.length,
    abstain: 0,
    veto: 0,
    total,
    totalVotedPercentage: BigNumber(totalCouncilVotingPower)
      .div(totalVoted)
      .toNumber()
      .toFixed(4) // the percent conversion is done in the FE. No need to multiply by 100
  }
}

function democracyTallyReducer(proposal) {
  // if we consider democracyProposals like the parallel to Cosmos proposals in deposit periods, then
  // we would have to turn the seconds concept into a deposit somehow
  return {
    yes: proposal.seconds.length
  }
}

function topVoterReducer(
  topVoterAddress,
  electionInfo,
  accountInfo,
  validators,
  network
) {
  const { identity, nickname } = accountInfo || {}
  const councilMemberInfo = electionInfo.members.find(
    (electionInfoMember) =>
      electionInfoMember[0].toHuman() === topVoterAddress.toHuman()
  )
  return {
    name: nickname || identity.display,
    address: topVoterAddress,
    votingPower: councilMemberInfo
      ? toViewDenom(network, councilMemberInfo[1])
      : '',
    validator: validators[topVoterAddress]
  }
}

// the status end time is a time "so and so days from the creation of the proposal opening"
function getStatusEndTime(blockHeight, endBlock) {
  return new Date(
    new Date().getTime() + (endBlock - blockHeight) * 6000
  ).toUTCString()
}

module.exports = {
  blockReducer,
  validatorReducer,
  balanceReducer,
  balanceV2Reducer,
  delegationReducer,
  undelegationReducer,
  extractInvolvedAddresses,
  transactionsReducerV2,
  transactionDetailsReducer,
  sendDetailsReducer,
  coinReducer,
  rewardReducer,
  rewardsReducer,
  dbRewardsReducer,
  depositReducer,
  networkAccountReducer,
  getExtrinsicSuccess,
  identityReducer,
  democracyProposalReducer,
  democracyReferendumReducer,
  treasuryProposalReducer,
  tallyReducer,
  topVoterReducer
}
