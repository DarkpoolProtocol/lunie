const { RESTDataSource, HTTPCache } = require('apollo-datasource-rest')
const { InMemoryLRUCache } = require('apollo-server-caching')
const BigNumber = require('bignumber.js')
const _ = require('lodash')
const { encodeB32, decodeB32, pubkeyToAddress } = require('../tools')
const { UserInputError } = require('apollo-server')
const { getNetworkGasPrices } = require('../../data/network-fees')
const { fixDecimalsAndRoundUpBigNumbers } = require('../../common/numbers.js')
const delegationEnum = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' }

class CosmosV0API extends RESTDataSource {
  constructor(network, store, fiatValuesAPI, db) {
    super()
    this.baseURL = network.api_url
    this.initialize({})
    this.network = network
    this.networkId = network.id
    this.delegatorBech32Prefix = network.address_prefix
    this.validatorConsensusBech32Prefix = `${network.address_prefix}valcons`
    this.gasPrices = getNetworkGasPrices(network.id)
    this.store = store
    this.fiatValuesAPI = fiatValuesAPI
    this.db = db

    this.setReducers()
  }

  initialize(config) {
    this.context = config.context
    // manually set cache to checking it
    this.cache = new InMemoryLRUCache()
    this.httpCache = new HTTPCache(this.cache, this.httpFetch)
  }

  setReducers() {
    this.reducers = require('../reducers/cosmosV0-reducers')
  }

  // hacky way to get error text
  async getError(url) {
    try {
      return await this.get(url)
    } catch (error) {
      return error.extensions.response.body.error
    }
  }

  async getRetry(url, intent = 0) {
    // check cache size, and flush it if it's bigger than something
    if ((await this.cache.getTotalSize()) > 100000) {
      await this.cache.flush()
    }
    // clearing memoizedResults
    this.memoizedResults.clear()
    try {
      return await this.get(url, null, { cacheOptions: { ttl: 1 } }) // normally setting cacheOptions should be enought, but...
    } catch (error) {
      // give up
      if (intent >= 3) {
        console.error(
          `Error for query ${url} in network ${this.networkId} (tried 3 times)`
        )
        throw error
      }

      // retry
      await new Promise((resolve) => setTimeout(() => resolve(), 1000))
      return this.getRetry(url, intent + 1)
    }
  }

  // querying data from the cosmos REST API
  // is overwritten in cosmos v2 to extract from a differnt result format
  // some endpoints /blocks and /txs have a different response format so they use this.get directly
  async query(url) {
    return this.getRetry(url)
  }

  async getSignedBlockWindow() {
    const slashingParams = await this.query('/slashing/parameters')
    return slashingParams.signed_blocks_window
  }

  checkAddress(address) {
    if (!address.startsWith(this.delegatorBech32Prefix)) {
      throw new UserInputError(
        `The address you entered doesn't belong to the ${this.network.title} network`
      )
    }
  }

  async getTransactionsV2ByHeight(height) {
    const txs = await this.loadPaginatedTxs(`txs?tx.height=${height}`)
    return Array.isArray(txs)
      ? this.reducers.transactionsReducerV2(
          this.network,
          txs,
          this.reducers,
          this.network.stakingDenom
        )
      : []
  }

  async getValidatorSigningInfos(validators) {
    const signingInfos = await Promise.all(
      validators.map(({ consensus_pubkey }) =>
        this.getValidatorSigningInfo(consensus_pubkey)
      )
    )

    return signingInfos
  }

  async getValidatorSigningInfo(validatorConsensusPubKey) {
    try {
      const exceptions = [
        `cosmosvalconspub1zcjduepqx38v580cmd9em3n7mcgzj22jwdwks5lr3lfxl8g87vzjp7jyyszsr4xvzv`,
        `cosmosvalconspub1zcjduepqlzmd0spn9m0m3eq9zp93d4w6e5tugamv44yqjzyacelnvra634fqnfec0r`
      ]
      if (exceptions.indexOf(validatorConsensusPubKey) !== -1) {
        throw Error()
      }
      const response = await this.query(
        `slashing/validators/${validatorConsensusPubKey}/signing_info`,
        { cacheOptions: { ttl: 60 } }
      )
      return {
        address: pubkeyToAddress(
          validatorConsensusPubKey,
          this.validatorConsensusBech32Prefix
        ),
        ...response
      }
    } catch (e) {
      return {
        address: pubkeyToAddress(
          validatorConsensusPubKey,
          this.validatorConsensusBech32Prefix
        ),
        missed_blocks_counter: '0',
        start_height: '0'
      }
    }
  }

  async getAllValidatorSets(height = 'latest') {
    const response = await this.query(`validatorsets/${height}`)
    return response
  }

  async getSelfStake(validator) {
    const hexDelegatorAddressFromOperator = decodeB32(validator.operatorAddress)
    const delegatorAddressFromOperator = encodeB32(
      hexDelegatorAddressFromOperator,
      this.delegatorBech32Prefix
    )

    let selfDelegation
    try {
      selfDelegation = await this.query(
        `staking/delegators/${delegatorAddressFromOperator}/delegations/${validator.operatorAddress}`
      )
    } catch (error) {
      // in some rare cases the validator has no self delegation so this query fails

      if (error.extensions.response.status === 500) {
        const parsedErrorLog = JSON.parse(error.extensions.response.body.error)
        if (parsedErrorLog.message.startsWith('no delegation for this')) {
          return 0
        }
      }

      // still throw in every other unknown case
      throw error
    }

    return this.reducers.delegationReducer(
      selfDelegation,
      validator,
      delegationEnum.ACTIVE
    ).amount
  }

  async getAllValidators(height) {
    let [
      validators,
      annualProvision,
      validatorSet,
      signedBlocksWindow
    ] = await Promise.all([
      Promise.all([
        this.query(`staking/validators?status=unbonding`),
        this.query(`staking/validators?status=bonded`),
        this.query(`staking/validators?status=unbonded`)
      ]).then((validatorGroups) => [].concat(...validatorGroups)),
      this.getAnnualProvision(),
      this.getAllValidatorSets(height),
      this.getSignedBlockWindow()
    ])

    // create a dictionary to reduce array lookups
    const consensusValidators = _.keyBy(validatorSet.validators, 'address')
    const totalVotingPower = validatorSet.validators.reduce(
      (sum, { voting_power }) => sum.plus(voting_power),
      BigNumber(0)
    )

    // query for signing info
    const signingInfos = _.keyBy(
      await this.getValidatorSigningInfos(validators),
      'address'
    )

    validators.forEach((validator) => {
      const consensusAddress = pubkeyToAddress(
        validator.consensus_pubkey,
        this.validatorConsensusBech32Prefix
      )
      validator.voting_power = consensusValidators[consensusAddress]
        ? BigNumber(consensusValidators[consensusAddress].voting_power)
            .div(totalVotingPower)
            .toNumber()
        : 0
      validator.signing_info = signingInfos[consensusAddress]
    })

    return validators.map((validator) =>
      this.reducers.validatorReducer(
        this.network.id,
        signedBlocksWindow,
        validator,
        annualProvision
      )
    )
  }

  async getDetailedVotes(proposal) {
    const [
      votes,
      deposits,
      tally,
      tallyingParameters,
      depositParameters,
      links
    ] = await Promise.all([
      this.query(`/gov/proposals/${proposal.id}/votes`),
      this.query(`/gov/proposals/${proposal.id}/deposits`),
      this.query(`/gov/proposals/${proposal.id}/tally`),
      this.query(`/gov/parameters/tallying`),
      this.query(`/gov/parameters/deposit`),
      this.db.getNetworkLinks(this.network.id)
    ])
    const totalVotingParticipation = BigNumber(tally.yes)
      .plus(tally.abstain)
      .plus(tally.no)
      .plus(tally.no_with_veto)
    const formattedDeposits = deposits
      ? deposits.map((deposit) =>
          this.reducers.depositReducer(deposit, this.network)
        )
      : undefined
    const depositsSum = formattedDeposits
      ? formattedDeposits.reduce((depositAmountAggregator, deposit) => {
          return (depositAmountAggregator += Number(deposit.amount[0].amount))
        }, 0)
      : undefined
    return {
      deposits: formattedDeposits,
      depositsSum: deposits ? Number(depositsSum).toFixed(6) : undefined,
      percentageDepositsNeeded: deposits
        ? fixDecimalsAndRoundUpBigNumbers(
            (depositsSum * 100) /
              fixDecimalsAndRoundUpBigNumbers(
                depositParameters.min_deposit[0].amount,
                6,
                this.network
              ),
            2,
            this.network
          )
        : undefined,
      votes: votes
        ? votes.map((vote) => this.reducers.voteReducer(vote))
        : undefined,
      votesSum: votes ? votes.length : undefined,
      votingThresholdYes: Number(tallyingParameters.threshold).toFixed(2),
      votingThresholdNo: (1 - tallyingParameters.threshold).toFixed(2),
      votingPercentageYes:
        totalVotingParticipation.toNumber() > 0
          ? BigNumber(tally.yes)
              .times(100)
              .div(totalVotingParticipation)
              .toNumber()
              .toFixed(2)
          : 0,
      votingPercentageNo:
        totalVotingParticipation.toNumber() > 0
          ? BigNumber(tally.no)
              .plus(tally.no_with_veto)
              .times(100)
              .div(totalVotingParticipation)
              .toNumber()
              .toFixed(2)
          : 0,
      links,
      timeline: [
        { title: `Proposal created`, time: proposal.submit_time },
        {
          title: `Proposal deposit period ends`,
          time: proposal.deposit_end_time
        },
        {
          title: `Proposal voting period starts`,
          time: proposal.voting_start_time
        },
        { title: `Proposal voting period ends`, time: proposal.voting_end_time }
      ]
    }
  }

  async getAllProposals(validators) {
    const response = await this.query('gov/proposals')
    const { bonded_tokens: totalBondedTokens } = await this.query(
      '/staking/pool'
    )
    if (!Array.isArray(response)) return []
    const proposals = await Promise.all(
      response.map(async (proposal) => {
        const [tally, proposer] = await Promise.all([
          this.query(`gov/proposals/${proposal.id}/tally`),
          this.query(`gov/proposals/${proposal.id}/proposer`).catch(() => {
            return { proposer: undefined }
          })
        ])
        const detailedVotes = await this.getDetailedVotes(proposal)
        return this.reducers.proposalReducer(
          this.network.id,
          proposal,
          tally,
          proposer,
          totalBondedTokens,
          detailedVotes,
          this.reducers,
          validators
        )
      })
    )

    return _.orderBy(proposals, 'id', 'desc')
  }

  async getProposalById(proposalId, validators) {
    const proposal = await this.query(`gov/proposals/${proposalId}`).catch(
      () => {
        throw new UserInputError(
          `There is no proposal in the network with ID '${proposalId}'`
        )
      }
    )
    const [
      tally,
      proposer,
      { bonded_tokens: totalBondedTokens },
      detailedVotes
    ] = await Promise.all([
      this.query(`gov/proposals/${proposalId}/tally`),
      this.query(`gov/proposals/${proposalId}/proposer`).catch(() => {
        return { proposer: undefined }
      }),
      this.query(`/staking/pool`),
      this.getDetailedVotes(proposal)
    ])
    return this.reducers.proposalReducer(
      this.network.id,
      proposal,
      tally,
      proposer,
      totalBondedTokens,
      detailedVotes,
      this.reducers,
      validators
    )
  }

  async getGovernanceParameters() {
    const depositParameters = await this.query(`gov/parameters/deposit`)
    const tallyingParamers = await this.query(`gov/parameters/tallying`)

    return this.reducers.governanceParameterReducer(
      depositParameters,
      tallyingParamers
    )
  }

  async getTopVoters() {
    // for now defaulting to pick the 10 largest voting powers
    return _.take(
      _.reverse(
        _.sortBy(this.store.validators, [
          (validator) => {
            return validator.votingPower
          }
        ])
      ),
      10
    )
  }

  async getGovernanceOverview() {
    const { bonded_tokens: totalBondedTokens } = await this.query(
      '/staking/pool'
    )
    const [communityPoolArray, links, topVoters] = await Promise.all([
      this.query('/distribution/community_pool'),
      this.db.getNetworkLinks(this.network.id),
      this.getTopVoters()
    ])
    const communityPool = communityPoolArray.find(
      ({ denom }) => denom === this.network.coinLookup[0].chainDenom
    ).amount
    return {
      totalStakedAssets: fixDecimalsAndRoundUpBigNumbers(
        totalBondedTokens,
        2,
        this.network,
        this.network.stakingDenom
      ),
      totalVoters: undefined,
      treasurySize: fixDecimalsAndRoundUpBigNumbers(
        communityPool,
        2,
        this.network,
        this.network.stakingDenom
      ),
      topVoters: topVoters.map((topVoter) =>
        this.reducers.topVoterReducer(topVoter)
      ),
      links: JSON.parse(links)
    }
  }

  async getDelegatorVote({ proposalId, address }) {
    this.checkAddress(address)
    const response = await this.query(`gov/proposals/${proposalId}/votes`)
    const votes = response || []
    const vote = votes.find(({ voter }) => voter === address) || {}
    return {
      option: vote.option
    }
  }

  async getBlockByHeightV2(blockHeight) {
    let block, transactions
    if (blockHeight) {
      const response = await Promise.all([
        this.getRetry(`blocks/${blockHeight}`),
        this.getTransactionsV2ByHeight(blockHeight)
      ])
      block = response[0]
      transactions = response[1]
    } else {
      block = await this.getRetry(`blocks/latest`)
      transactions = await this.getTransactionsV2ByHeight(
        block.block_meta.header.height
      )
    }
    return this.reducers.blockReducer(this.network.id, block, transactions)
  }

  async getBlockV2(blockHeight) {
    if (!blockHeight || this.store.height === blockHeight) {
      return this.store.block
    } else {
      return this.getBlockByHeightV2(blockHeight)
    }
  }

  // DEPRECATE
  async getBalancesFromAddress(address, fiatCurrency, network) {
    this.checkAddress(address)
    const response = await this.query(`bank/balances/${address}`)
    let balances = response || []
    const coins = balances.map((coin) => {
      const coinLookup = network.getCoinLookup(network, coin.denom)
      return this.reducers.coinReducer(coin, coinLookup)
    })
    const fiatValues = await this.fiatValuesAPI.calculateFiatValues(
      coins,
      fiatCurrency
    )
    return await Promise.all(
      coins.map((coin) => {
        return this.reducers.balanceReducer(
          coin,
          this.gasPrices,
          fiatValues[coin.denom],
          fiatCurrency
        )
      })
    )
  }

  async getBalancesV2FromAddress(address, fiatCurrency, network) {
    this.checkAddress(address)
    const [balancesResponse, delegations, undelegations] = await Promise.all([
      this.query(`bank/balances/${address}`),
      this.getDelegationsForDelegatorAddress(address),
      this.getUndelegationsForDelegatorAddress(address)
    ])
    const balances = balancesResponse || []
    const coins = balances.map((coin) => {
      const coinLookup = network.getCoinLookup(network, coin.denom)
      return this.reducers.coinReducer(coin, coinLookup)
    })
    // also check if there are any balances as rewards
    const rewards = await this.getRewards(address, fiatCurrency, network)
    const rewardsBalances = rewards.reduce((coinsAggregator, reward) => {
      if (
        !coins.find((coin) => coin.denom === reward.denom) &&
        !coinsAggregator.find((coin) => coin.denom === reward.denom)
      ) {
        coinsAggregator.push({
          amount: 0,
          denom: reward.denom
        })
      }
      return coinsAggregator
    }, [])
    // join regular balances and rewards balances
    coins.push(...rewardsBalances)
    const hasStakingDenom = coins.find(
      ({ denom }) => denom === this.network.stakingDenom
    )
    // the user might not have liquid staking tokens but have staking tokens delegated
    // if we don't add the staking denom, we would show a 0 total for the staking denom which is wrong
    if (!hasStakingDenom) {
      coins.push({
        amount: BigNumber(0),
        denom: this.network.stakingDenom
      })
    }
    const fiatValueAPI = this.fiatValuesAPI
    return await Promise.all(
      coins.map((coin) => {
        return this.reducers.balanceV2Reducer(
          coin,
          this.network.stakingDenom,
          delegations,
          undelegations,
          fiatValueAPI,
          fiatCurrency
        )
      })
    )
  }

  async getAccountInfo(address) {
    if (!address.startsWith(this.network.address_prefix)) {
      throw new UserInputError("This address doesn't exist in this network")
    }
    const response = await this.query(`auth/accounts/${address}`)
    const accountType = response.type
    const accountValue = response && response.value
    return this.reducers.accountInfoReducer(accountValue, accountType)
  }

  async getDelegationsForDelegatorAddress(address) {
    this.checkAddress(address)
    let delegations =
      (await this.query(`staking/delegators/${address}/delegations`)) || []

    return delegations
      .filter((delegation) =>
        BigNumber(delegation.balance).isGreaterThanOrEqualTo(1)
      )
      .map((delegation) =>
        this.reducers.delegationReducer(
          delegation,
          this.store.validators[delegation.validator_address],
          delegationEnum.ACTIVE
        )
      )
  }

  async getUndelegationsForDelegatorAddress(address) {
    this.checkAddress(address)
    let undelegations =
      (await this.query(
        `staking/delegators/${address}/unbonding_delegations`
      )) || []

    // undelegations come in a nested format { validator_address, delegator_address, entries }
    // we flatten the format to be able to easier iterate over the list
    const flattenedUndelegations = undelegations.reduce(
      (list, undelegation) =>
        list.concat(
          undelegation.entries.map((entry) => ({
            validator_address: undelegation.validator_address,
            delegator_address: undelegation.delegator_address,
            balance: entry.balance,
            completion_time: entry.completion_time,
            creation_height: entry.creation_height,
            initial_balance: entry.initial_balance
          }))
        ),
      []
    )
    return flattenedUndelegations.map((undelegation) =>
      this.reducers.undelegationReducer(
        undelegation,
        this.store.validators[undelegation.validator_address]
      )
    )
  }

  async getDelegationForValidator(delegatorAddress, validator) {
    this.checkAddress(delegatorAddress)
    const operatorAddress = validator.operatorAddress
    const delegation = await this.query(
      `staking/delegators/${delegatorAddress}/delegations/${operatorAddress}`
    ).catch(() => ({
      validator_address: operatorAddress,
      delegator_address: delegatorAddress,
      shares: 0
    }))
    return this.reducers.delegationReducer(
      delegation,
      validator,
      delegationEnum.ACTIVE
    )
  }

  async getAnnualProvision() {
    const response = await this.query(`minting/annual-provisions`)
    return response
  }

  async getExpectedReturns(validator) {
    const annualProvision = await this.getAnnualProvision()
    const expectedReturns = this.reducers.expectedRewardsPerToken(
      validator,
      validator.commission,
      annualProvision
    )
    return expectedReturns
  }

  async getRewards(delegatorAddress, fiatCurrency, network) {
    this.checkAddress(delegatorAddress)
    const result = await this.query(
      `distribution/delegators/${delegatorAddress}/rewards`
    )
    const rewards = (result.rewards || []).filter(
      ({ reward }) => reward && reward.length > 0
    )
    return this.reducers.rewardReducer(
      rewards,
      this.store.validators,
      fiatCurrency,
      this.calculateFiatValue && this.calculateFiatValue.bind(this),
      this.reducers,
      network
    )
  }

  async getAllDelegators() {
    const allDelegations = await Object.keys(this.store.validators).reduce(
      async (all, validator) => {
        const delegations = await this.query(
          `staking/validators/${validator}/delegations`
        )
        return (await all).concat(delegations)
      },
      []
    )
    return _.uniqBy(allDelegations, 'delegator_address').map(
      ({ delegator_address }) => delegator_address
    )
  }

  async getTransactions(address) {
    this.checkAddress(address)

    const txs = await Promise.all([
      this.loadPaginatedTxs(`/txs?sender=${address}`),
      this.loadPaginatedTxsget(`/txs?recipient=${address}`),
      this.loadPaginatedTxs(`/txs?action=submit_proposal&proposer=${address}`),
      this.loadPaginatedTxs(`/txs?action=deposit&depositor=${address}`),
      this.loadPaginatedTxs(`/txs?action=vote&voter=${address}`),
      this.loadPaginatedTxs(`/txs?action=delegate&delegator=${address}`),
      this.loadPaginatedTxs(
        `/txs?action=begin_redelegate&delegator=${address}`
      ),
      this.loadPaginatedTxs(`/txs?action=begin_unbonding&delegator=${address}`),
      this.loadPaginatedTxs(
        `/txs?action=withdraw_delegator_reward&delegator=${address}`
      ),
      this.loadPaginatedTxs(
        `/txs?action=withdraw_validator_rewards_all&source-validator=${address}`
      )
    ]).then((transactionGroups) => [].concat(...transactionGroups))
    return this.reducers.formatTransactionsReducer(txs, this.reducers)
  }

  async loadPaginatedTxs(url, page = 1, totalAmount = 0) {
    const pagination = `&limit=1000000000&page=${page}`
    let allTxs = []

    const { txs, total_count } = await this.getRetry(`${url}${pagination}`)
    allTxs = allTxs.concat(txs)

    // there is a bug in page_number in gaia-13007 so we can't use is
    if (allTxs.length + totalAmount < Number(total_count)) {
      return allTxs.concat(
        await this.loadPaginatedTxs(url, page + 1, totalAmount + allTxs.length)
      )
    }

    return allTxs
  }
}

module.exports = CosmosV0API
