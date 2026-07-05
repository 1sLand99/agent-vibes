export interface CodexAccountSelection<TAccount> {
  account: TAccount
  index: number
  nextIndex: number
}

export function normalizeCodexAccountIndex(
  index: number,
  accountCount: number
): number {
  if (accountCount <= 0 || !Number.isFinite(index)) {
    return 0
  }

  const truncated = Math.trunc(index)
  return ((truncated % accountCount) + accountCount) % accountCount
}

export function findCodexAccountFromIndex<TAccount>(
  accounts: readonly TAccount[],
  startIndex: number,
  isCandidateUsable: (account: TAccount, index: number) => boolean
): CodexAccountSelection<TAccount> | null {
  if (accounts.length === 0) {
    return null
  }

  const normalizedStart = normalizeCodexAccountIndex(
    startIndex,
    accounts.length
  )

  for (let offset = 0; offset < accounts.length; offset++) {
    const index = (normalizedStart + offset) % accounts.length
    const account = accounts[index]
    if (account === undefined) {
      continue
    }

    if (isCandidateUsable(account, index)) {
      return {
        account,
        index,
        nextIndex: (index + 1) % accounts.length,
      }
    }
  }

  return null
}
